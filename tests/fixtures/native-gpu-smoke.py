import json
import os
import platform
from pathlib import Path

import torch

torch.set_num_threads(1)
torch.manual_seed(int(os.environ.get('DSH_SEED', '11')))
assert torch.cuda.is_available(), 'CUDA is unavailable'
assert torch.cuda.device_count() == 1, 'select exactly one GPU'
torch.backends.cuda.matmul.allow_tf32 = False
a = torch.randint(-3, 4, (512, 512)).float()
b = torch.randint(-3, 4, (512, 512)).float()
expected = a @ b
actual = (a.cuda() @ b.cuda()).cpu()
torch.cuda.synchronize()
error = (actual - expected).abs().max().item()
assert error == 0, f'CPU/GPU mismatch: {error}'
print(json.dumps({
    'python': platform.python_version(), 'torch': torch.__version__,
    'cuda': torch.version.cuda, 'device': torch.cuda.get_device_name(0),
    'capability': torch.cuda.get_device_capability(0),
    'visible_devices': os.environ.get('CUDA_VISIBLE_DEVICES'),
    'max_abs_error': error, 'peak_allocated_bytes': torch.cuda.max_memory_allocated(),
}), flush=True)
if 'DSH_OUTPUTS_DIR' in os.environ:
    assert len(list(Path(os.environ['DSH_DATA_DIR']).iterdir())) == 1
    (Path(os.environ['DSH_OUTPUTS_DIR']) / 'metrics.json').write_text(json.dumps({
        'schema_version': 1, 'run_id': os.environ['DSH_RUN_ID'],
        'contract_id': os.environ['DSH_CONTRACT_ID'], 'seed': int(os.environ['DSH_SEED']),
        'metrics': [{'name': 'accuracy', 'value': 1.0}],
    }))
