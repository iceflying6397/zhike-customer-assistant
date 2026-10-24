"""脚本共用的路径，并让脚本能导入 cloud-functions/api 里的共享代码。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API_DIR = ROOT / "cloud-functions" / "api"
DATA_FILE = ROOT / "data" / "crm.json"
CACHE_DIR = ROOT / "cache"
PUBLIC_DATA = ROOT / "public" / "data"

sys.path.insert(0, str(API_DIR))
