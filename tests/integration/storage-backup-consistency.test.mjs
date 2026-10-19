import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { LocalObjectStore } from '../../dependency/platform/ServerKit/dist/storage.js'
import { createFileService } from '../../backend/tenant/dist/modules/files.js'
import { tenantLoginUrl, testTenants } from '../helpers/fixture.mjs'

test('recovery gate keeps object bytes consistent with committed upload/delete metadata', async () => {
  assert.equal(process.env.NODE_ENV, 'test')
  const { alpha } = testTenants().tenants
  const cred = JSON.parse(await readFile(path.join(process.env.TENANT_CREDENTIALS_DIR,`${alpha.credentialRef}.json`)))
  const objects = `"${cred.schemaName}".stored_object`
  const dir = await mkdtemp(path.join(os.tmpdir(),'storage-recovery-'))
  const store = new LocalObjectStore(dir)
  const pool = new pg.Pool({connectionString:tenantLoginUrl(alpha)})
  const admin = new pg.Client({connectionString:process.env.DATABASE_ADMIN_URL})
  const backup = new pg.Client({connectionString:process.env.DATABASE_ADMIN_URL})
  await admin.connect(); await backup.connect()
  let releasePut, startedPut
  const putting = new Promise(resolve=>{startedPut=resolve})
  const holdPut = new Promise(resolve=>{releasePut=resolve})
  const gatedStore = {put:async(...args)=>{startedPut();await holdPut;return store.put(...args)},delete:key=>store.delete(key)}
  const kit = {
    tenant:()=>({schemaName:cred.schemaName}),
    config:async()=>({values:{'limit.storage.max_file_mb':1}}),
    withTenant:async(_request, callback)=>{
      const c=await pool.connect()
      try {
        await c.query('begin');await c.query(`set local role "${cred.dbRole}"`)
        await c.query(`set local search_path="${cred.schemaName}",pg_catalog`)
        await c.query("select set_config('app.tenant_id',$1,true)",[cred.tenantId])
        const result=await callback(c);await c.query('commit');return result
      }catch(e){await c.query('rollback');throw e}finally{c.release()}
    },
  }
  const service = createFileService({activeRef:()=> 'vds',store:async()=>gatedStore}).service(kit)
  const waitForBlocked = async pid => {
    for(let i=0;i<100;i++) {
      const r=await admin.query("select count(*)::int as n from pg_locks where locktype='advisory' and not granted and pid=$1",[pid])
      if(r.rows[0].n)return
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    assert.fail('expected the backup to wait for the in-flight object publication')
  }
  let file
  try {
    const save=service.save({}, {fileName:'recovery-probe.txt',contentType:'text/plain',body:Buffer.from('synthetic recovery content'),createdBy:null})
    await putting
    const lock=backup.query('select pg_advisory_lock(hashtext($1))',['skeleton-local-storage-backup'])
    await waitForBlocked(backup.processID)
    releasePut();file=await save;await lock
    const row=(await admin.query(`select object_key from ${objects} where object_id=$1`,[file.id])).rows[0]
    assert.ok(row,'metadata committed before the backup acquired its gate')
    assert.equal((await readFile(path.join(dir,row.object_key))).toString(),'synthetic recovery content')
    const deletion=service.remove({},file.id)
    let finished=false;deletion.then(()=>{finished=true})
    await new Promise(resolve=>setTimeout(resolve,40))
    assert.equal(finished,false,'deletion cannot remove bytes during the recovery snapshot')
    assert.equal((await readFile(path.join(dir,row.object_key))).toString(),'synthetic recovery content')
    await backup.query('select pg_advisory_unlock(hashtext($1))',['skeleton-local-storage-backup'])
    assert.equal(await deletion,true)
    assert.equal((await admin.query(`select count(*)::int as n from ${objects} where object_id=$1`,[file.id])).rows[0].n,0)
    await assert.rejects(readFile(path.join(dir,row.object_key)),{code:'ENOENT'})
  }finally{
    releasePut?.();await backup.end();
    if(file)await admin.query(`delete from ${objects} where object_id=$1`,[file.id])
    await admin.end();await pool.end();await rm(dir,{recursive:true,force:true})
  }
})
