import json, os, shutil, subprocess, sys, urllib.request, urllib.error, zipfile

# 스크립트가 있는 디렉토리로 이동 (git 명령어 등이 제대로 동작하도록)
os.chdir(os.path.dirname(os.path.abspath(__file__)))

# ─── 버전 입력 ───
version = input("새 버전 입력 (예: 1.2.0): ").strip().lstrip("vV")
if not version:
    print("버전을 입력하세요.")
    sys.exit(1)

# ─── 설정 로드 (첫 실행 시 입력) ───
config_file = "deploy_config.json"
config = {}
try:
    with open(config_file, "r", encoding="utf-8") as f:
        config = json.load(f)
except FileNotFoundError:
    pass

changed = False
if not config.get("url"):
    config["url"] = input("Supabase URL: ").strip()
    changed = True
if not config.get("service_key"):
    config["service_key"] = input("Supabase Service Role Key: ").strip()
    changed = True
if not config.get("github_token"):
    print("\n[GitHub] Personal Access Token이 필요합니다 (repo 권한)")
    print("  https://github.com/settings/tokens 에서 생성")
    config["github_token"] = input("GitHub Token: ").strip()
    changed = True
if not config.get("github_repo"):
    config["github_repo"] = input("GitHub Repo (예: taxjung85/messenger): ").strip()
    changed = True
if changed:
    with open(config_file, "w", encoding="utf-8") as f:
        json.dump(config, f)
    print(f"[저장됨] {config_file}\n")

# ─── 헬퍼: GitHub API 호출 ───
def github_api(method, path, data=None, content_type="application/json"):
    url = f"https://api.github.com{path}"
    body = json.dumps(data).encode("utf-8") if data else None
    req = urllib.request.Request(url, data=body, method=method, headers={
        "Authorization": f'token {config["github_token"]}',
        "Accept": "application/vnd.github+json",
        "Content-Type": content_type,
        "User-Agent": "deploy-script",
    })
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read().decode("utf-8"))

def github_upload(upload_url, file_path, file_name):
    """Release에 zip 파일 업로드"""
    # upload_url에서 {?name,label} 템플릿 제거
    upload_url = upload_url.split("{")[0] + f"?name={file_name}"
    with open(file_path, "rb") as f:
        body = f.read()
    req = urllib.request.Request(upload_url, data=body, method="POST", headers={
        "Authorization": f'token {config["github_token"]}',
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/zip",
        "User-Agent": "deploy-script",
    })
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read().decode("utf-8"))

# ─── Supabase 헬퍼 ───
supa_key = config["service_key"]
supa_headers = {
    "apikey": supa_key,
    "Authorization": f"Bearer {supa_key}",
    "Content-Type": "application/json",
}

def supa_upsert(key, value):
    """settings 테이블에 UPSERT (service_role key로 RLS 우회)"""
    url = f'{config["url"]}/rest/v1/settings'
    data = json.dumps({"key": key, "value": value}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={
        **supa_headers, "Prefer": "resolution=merge-duplicates,return=representation",
    })
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read().decode("utf-8"))

repo = config["github_repo"]

# ─── 1/5. manifest.json 버전 업데이트 ───
manifest_path = "extension/manifest.json"
with open(manifest_path, "r", encoding="utf-8-sig") as f:
    manifest = json.load(f)
manifest["version"] = version
with open(manifest_path, "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
print(f"[1/5] manifest.json → v{version}")

# ─── 2/5. Supabase app_version 업데이트 ───
try:
    result = supa_upsert("app_version", version)
    print(f"[2/5] Supabase app_version → v{version}")
except Exception as e:
    print(f"[2/5] ❌ Supabase app_version 실패: {e}")
    sys.exit(1)

# ─── 3/5. Git 커밋 + 푸시 ───
subprocess.run(["git", "add", "extension/", "deploy.py", "deploy.bat", ".gitignore"], check=True)
subprocess.run(["git", "commit", "-m", f"v{version}"], check=True)
subprocess.run(["git", "push", "origin", "main"], check=True)
print(f"[3/5] GitHub 푸시 완료")

# ─── 4/5. GitHub Release 생성 + zip 업로드 + download_url 저장 ───
src_ext = os.path.join(os.path.dirname(os.path.abspath(__file__)), "extension")
zip_name = f"extension-v{version}.zip"
zip_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), zip_name)

with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(src_ext):
        for f in files:
            full = os.path.join(root, f)
            arc = os.path.join("extension", os.path.relpath(full, src_ext))
            zf.write(full, arc)

try:
    # Release 생성
    release = github_api("POST", f"/repos/{repo}/releases", {
        "tag_name": f"v{version}",
        "name": f"v{version}",
        "body": f"v{version} 릴리스",
    })
    print(f"[4/5] GitHub Release v{version} 생성 완료")

    # zip 업로드
    asset = github_upload(release["upload_url"], zip_path, zip_name)
    download_url = asset["browser_download_url"]
    print(f"      에셋 업로드 완료: {zip_name}")

    # Supabase에 download_url 저장
    supa_upsert("download_url", download_url)
    print(f"      Supabase download_url 저장 완료")

except urllib.error.HTTPError as e:
    err_body = e.read().decode("utf-8", errors="replace")
    print(f"[4/5] ❌ GitHub Release 실패 ({e.code}): {err_body}")
except Exception as e:
    print(f"[4/5] ❌ GitHub Release 실패: {e}")
finally:
    if os.path.exists(zip_path):
        os.remove(zip_path)

# ─── 5/5. 로컬 확장 폴더에 복사 (Chrome 유지용) ───
local_ext = r"C:\extension"
try:
    shutil.copytree(src_ext, local_ext, dirs_exist_ok=True)
    print(f"[5/5] C:\\extension\\ 복사 완료")
except Exception as e:
    print(f"[5/5] ❌ 로컬 복사 실패: {e}")

print(f"\n===== v{version} 배포 완료 =====")
