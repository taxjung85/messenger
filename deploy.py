import json, os, subprocess, sys, urllib.request

# 스크립트가 있는 디렉토리로 이동 (git 명령어 등이 제대로 동작하도록)
os.chdir(os.path.dirname(os.path.abspath(__file__)))

# ─── 버전 입력 ───
version = input("새 버전 입력 (예: 1.2.0): ").strip()
if not version:
    print("버전을 입력하세요.")
    sys.exit(1)

# ─── Supabase 정보 입력 (첫 실행 시) ───
config_file = "deploy_config.json"
config = {}
try:
    with open(config_file, "r", encoding="utf-8") as f:
        config = json.load(f)
except FileNotFoundError:
    pass

if not config.get("url") or not config.get("key"):
    print("\n[초기 설정] Supabase 정보를 입력하세요 (한번만 입력하면 저장됩니다)")
    config["url"] = input("Supabase URL: ").strip()
    config["key"] = input("Supabase Anon Key: ").strip()
    with open(config_file, "w", encoding="utf-8") as f:
        json.dump(config, f)
    print(f"[저장됨] {config_file}\n")

# ─── 1. manifest.json 버전 업데이트 ───
manifest_path = "extension/manifest.json"
with open(manifest_path, "r", encoding="utf-8-sig") as f:
    manifest = json.load(f)
manifest["version"] = version
with open(manifest_path, "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
print(f"[1/3] manifest.json → v{version}")

# ─── 2. Supabase settings 업데이트 ───
url = f'{config["url"]}/rest/v1/settings?key=eq.app_version'
data = json.dumps({"value": version}).encode("utf-8")
req = urllib.request.Request(url, data=data, method="PATCH", headers={
    "apikey": config["key"],
    "Authorization": f'Bearer {config["key"]}',
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
})
try:
    urllib.request.urlopen(req)
    print(f"[2/3] Supabase settings → v{version}")
except Exception as e:
    print(f"[2/3] Supabase 업데이트 실패: {e}")

# ─── 3. Git 커밋 + 푸시 ───
subprocess.run(["git", "add", "extension/", "deploy.py", "deploy.bat", ".gitignore"], check=True)
subprocess.run(["git", "commit", "-m", f"v{version}"], check=True)
subprocess.run(["git", "push", "origin", "main"], check=True)
print(f"[3/3] GitHub 푸시 완료")

print(f"\n===== v{version} 배포 완료 =====")
