"""Run three bounded long-history cases without exposing held-out answers to the model."""
import json, pathlib, sys, time, urllib.request, urllib.error, uuid
base=sys.argv[1].rstrip('/')
if not base.startswith('https://') or not base.endswith('.workers.dev'):
    raise SystemExit('Pass the isolated benchmark Worker URL')
root=pathlib.Path(__file__).parents[1]
secret=dict(line.split('=',1) for line in (root/'apps/benchmarks/.dev.vars.deployed').read_text().splitlines() if '=' in line)['ADMIN_TOKEN']
results=[]
for strategy in ['extractive','generic-summary','recent-window']:
    request=urllib.request.Request(f'{base}/context-{uuid.uuid4()}',json.dumps({'action':'context','strategy':strategy}).encode(),headers={'Content-Type':'application/json','User-Agent':'durable-harness-benchmark/0.1','Authorization':f'Bearer {secret}'})
    try:
        with urllib.request.urlopen(request,timeout=125) as response:result=json.load(response)
    except urllib.error.HTTPError as error:result={'strategy':strategy,'passed':False,'error':error.read().decode()}
    results.append(result);print(json.dumps(result),flush=True)
output=root/'.wrangler/proofs'/f'context-comparison-{int(time.time())}.json'
output.write_text(json.dumps({'model':'@cf/zai-org/glm-5.3-flash','results':results,'limitations':['One synthetic long-history case per strategy','All strategies retain and can search the same originals','No statistical recall or latency claim']},indent=2))
print(f'Proof: {output}')
