import json, os, shutil, subprocess, sys, urllib.request, zipfile

# 스크립트가 있는 디렉토리로 이동 (git 명령어 등이 제대로 동작하도록)
os.chdir(os.path.dirname(os.path.abspath(__file__)))

# ─── 버전 입력 ───
version = input("새 버전 입력 (예: 1.2.0): ").strip().lstrip("vV")
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
supa_headers = {
    "apikey": config["key"],
    "Authorization": f'Bearer {config["key"]}',
    "Content-Type": "application/json",
}
try:
    # PATCH (기존 행 업데이트 시도) — return=representation으로 실제 반영 여부 확인
    url = f'{config["url"]}/rest/v1/settings?key=eq.app_version'
    data = json.dumps({"value": version}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="PATCH", headers={
        **supa_headers, "Prefer": "return=representation",
    })
    resp = urllib.request.urlopen(req)
    body = json.loads(resp.read().decode("utf-8"))
    if body:
        print(f"[2/3] Supabase settings → v{version}")
    else:
        # PATCH 매칭 행 없음 → UPSERT로 새로 생성
        url2 = f'{config["url"]}/rest/v1/settings'
        data2 = json.dumps({"key": "app_version", "value": version}).encode("utf-8")
        req2 = urllib.request.Request(url2, data=data2, method="POST", headers={
            **supa_headers, "Prefer": "resolution=merge-duplicates",
        })
        urllib.request.urlopen(req2)
        print(f"[2/3] Supabase settings → v{version} (신규 생성)")
except Exception as e:
    print(f"[2/3] Supabase 업데이트 실패: {e}")

# ─── 3. Git 커밋 + 푸시 ───
subprocess.run(["git", "add", "extension/", "deploy.py", "deploy.bat", ".gitignore"], check=True)
subprocess.run(["git", "commit", "-m", f"v{version}"], check=True)
subprocess.run(["git", "push", "origin", "main"], check=True)
print(f"[3/5] GitHub 푸시 완료")

# ─── 4. GitHub Release 생성 (zip 첨부) ───
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
    subprocess.run(["gh", "release", "create", f"v{version}", zip_path,
                     "--title", f"v{version}", "--notes", f"v{version} 릴리스"],
                    check=True)
    print(f"[4/5] GitHub Release v{version} 생성 완료")
    # Supabase에 download_url 저장
    # gh api로 릴리스 에셋 URL 가져오기
    result = subprocess.run(["gh", "release", "view", f"v{version}", "--json", "assets"],
                            capture_output=True, text=True)
    if result.returncode == 0:
        assets = json.loads(result.stdout).get("assets", [])
        if assets:
            download_url = assets[0].get("url", "")
            # UPSERT로 download_url 저장 (행이 없어도 생성됨)
            dl_api_url = f'{config["url"]}/rest/v1/settings'
            dl_data = json.dumps({"key": "download_url", "value": download_url}).encode("utf-8")
            dl_req = urllib.request.Request(dl_api_url, data=dl_data, method="POST", headers={
                **supa_headers, "Prefer": "resolution=merge-duplicates",
            })
            urllib.request.urlopen(dl_req)
            print(f"    Supabase download_url 업데이트 완료")
except FileNotFoundError:
    print(f"[4/5] gh CLI 미설치 — Release 생성 건너뜀")
except Exception as e:
    print(f"[4/5] GitHub Release 실패: {e}")
finally:
    if os.path.exists(zip_path):
        os.remove(zip_path)

# ─── 5. 로컬 확장 폴더에 복사 (Chrome 유지용) ───
local_ext = r"C:\extension"
try:
    shutil.copytree(src_ext, local_ext, dirs_exist_ok=True)
    print(f"[5/5] C:\\extension\\ 복사 완료")
except Exception as e:
    print(f"[5/5] 로컬 복사 실패: {e}")

print(f"\n===== v{version} 배포 완료 =====")
