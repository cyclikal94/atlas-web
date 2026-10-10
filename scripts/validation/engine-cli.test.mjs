import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-engine-runner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const p of [
    "scripts/mutation",
    "scripts/integration",
    "src",
    ".agtx/bin",
  ])
    mkdirSync(join(dir, p), { recursive: true });
  cpSync(
    resolve(import.meta.dirname, "../run-engine-mutants.mjs"),
    join(dir, "scripts/run-engine-mutants.mjs"),
  );
  cpSync(import.meta.dirname, join(dir, "scripts/validation"), {
    recursive: true,
  });
  cpSync(
    resolve(import.meta.dirname, "../integration/free-port.mjs"),
    join(dir, "scripts/integration/free-port.mjs"),
  );
  writeFileSync(join(dir, ".gitignore"), ".agtx/\n");
  writeFileSync(join(dir, "src/input.ts"), "original");
  writeFileSync(
    join(dir, "scripts/mutation/data-catalogue.mjs"),
    `export const ENGINE=['MU-A','MU-B','MU-BAD'].map(id=>({id,title:id,file:'src/input.ts',spec:'tests/e2e/fixture.data-store.spec.ts',grep:'E-A3',expect:/required assertion/,patch:text=>{if(id==='MU-BAD')throw Error('anchor moved');return text+' changed';}}));`,
  );
  // A process-level simulator tests orchestration only. It does not execute Atlas,
  // Vite or browsers and its results are never used as product acceptance evidence.
  const fake = `#!${process.execPath}
import fs from 'node:fs';import http from 'node:http';import path from 'node:path';
const args=process.argv.slice(2), trace=process.env.ENGINE_TRACE;
const record=o=>fs.appendFileSync(trace,JSON.stringify({...o,at:Date.now()})+'\\n');
if(args[1]==='vite'&&args[2]==='build'){
 const out=process.env.ATLAS_MUTANT_OUT_DIR;fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'build-info.json'),JSON.stringify({mutant:process.env.ATLAS_MUTANT_DIR}));record({kind:'build',out});
}else if(args[1]==='vite'&&args[2]==='preview'){
 const port=Number(args[args.indexOf('--port')+1]),out=process.env.ATLAS_MUTANT_OUT_DIR;
 const s=http.createServer((q,r)=>{try{r.end(fs.readFileSync(path.join(out,q.url)));}catch{r.statusCode=404;r.end();}});s.listen(port,'127.0.0.1');
}else if(args[1]==='playwright'){
 const info=await(await fetch(process.env.ATLAS_FIXTURE_URL+'/build-info.json')).json();
 const bad=Boolean(info.mutant)||process.env.FAIL_CONTROL==='1';
 record({kind:'test-start',mutant:info.mutant,report:process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,evidence:process.env.ATLAS_EVIDENCE_DIR,url:process.env.ATLAS_FIXTURE_URL});
 await new Promise(r=>setTimeout(r,80));
 const projects=args.filter(a=>a.startsWith('--project=')).map(a=>a.slice(10));
 const report={suites:[{title:'spec',specs:[{title:'required assertion',tests:projects.map(projectName=>({projectName,expectedStatus:'passed',results:[{status:bad?'failed':'passed',errors:bad?[{message:'Error: expect(x).toBe(y)'}]:[]}]}))}]}]};
 fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,JSON.stringify(report));record({kind:'test-end',mutant:info.mutant});process.exitCode=bad?1:0;
}else{throw Error('Unexpected simulator command '+args.join(' '));}
`;
  writeFileSync(join(dir, ".agtx/bin/pnpm"), fake, { mode: 0o755 });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  return dir;
}
function run(dir, args, env = {}) {
  const trace = join(dir, ".agtx/trace.jsonl");
  const result = spawnSync(
    process.execPath,
    ["scripts/run-engine-mutants.mjs", ...args],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        PATH: `${dir}/.agtx/bin:${process.env.PATH}`,
        ENGINE_TRACE: trace,
        ...env,
      },
    },
  );
  assert.equal(result.error, undefined, result.stderr);
  const evidence = /Evidence: (.+)/.exec(result.stdout)?.[1];
  return {
    ...result,
    summary: JSON.parse(
      readFileSync(join(evidence, "engine-results.json"), "utf8"),
    ).summary,
    trace: existsSync(trace)
      ? readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse)
      : [],
  };
}
test("CLI preflight failure starts no build/server/browser processes", (t) => {
  const r = run(fixture(t), ["--only", "MU-A,MU-BAD", "--jobs", "2"]);
  assert.equal(r.status, 1);
  assert.equal(r.summary.preflight_pass, false);
  assert.deepEqual(r.trace, []);
});
test("CLI shares one control build and isolates bounded concurrent mutant jobs", (t) => {
  const r = run(fixture(t), ["--only", "MU-A,MU-B", "--jobs", "2"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.summary.caught, 2);
  assert.equal(r.summary.source_unchanged, true);
  assert.equal(r.trace.filter((x) => x.kind === "build").length, 3);
  const starts = r.trace.filter((x) => x.kind === "test-start");
  assert.equal(starts.length, 3);
  for (const field of ["report", "evidence", "url"])
    assert.equal(new Set(starts.map((x) => x[field])).size, 3);
  const mutantStarts = starts.filter((x) => x.mutant);
  const firstEnd = r.trace.filter((x) => x.kind === "test-end" && x.mutant)[0];
  assert.ok(
    mutantStarts.every((x) => x.at < firstEnd.at),
    "both independent jobs overlap",
  );
});
test("CLI failed control prevents building any mutants", (t) => {
  const r = run(fixture(t), ["--only", "MU-A,MU-B", "--jobs", "2"], {
    FAIL_CONTROL: "1",
  });
  assert.equal(r.status, 1);
  assert.equal(r.summary.controls_pass, false);
  assert.equal(r.trace.filter((x) => x.kind === "build").length, 1);
});
