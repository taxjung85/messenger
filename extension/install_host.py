"""
Native Messaging Host 설치 스크립트
사용법: python install_host.py <확장프로그램ID>
"""
import sys, os, json, winreg

def main():
    if len(sys.argv) < 2:
        print("사용법: python install_host.py <확장프로그램ID>")
        print("확장프로그램 ID는 chrome://extensions 에서 확인")
        input("Press Enter...")
        return

    ext_id = sys.argv[1].strip()
    script_dir = os.path.dirname(os.path.abspath(__file__))
    bat_path = os.path.join(script_dir, "native_host.bat")
    manifest_path = os.path.join(script_dir, "com.jungsem.messenger.json")

    # 1) 네이티브 호스트 매니페스트 생성
    manifest = {
        "name": "com.jungsem.messenger",
        "description": "Jungsem Messenger Native Host",
        "path": bat_path,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{ext_id}/"]
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print(f"[OK] 매니페스트 생성: {manifest_path}")

    # 2) 레지스트리 등록
    key_path = r"SOFTWARE\Google\Chrome\NativeMessagingHosts\com.jungsem.messenger"
    try:
        key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path)
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, manifest_path)
        winreg.CloseKey(key)
        print(f"[OK] 레지스트리 등록 완료")
    except Exception as e:
        print(f"[ERROR] 레지스트리 등록 실패: {e}")
        input("Press Enter...")
        return

    print()
    print(f"  확장프로그램 ID: {ext_id}")
    print(f"  매니페스트: {manifest_path}")
    print(f"  네이티브 호스트: {bat_path}")
    print()
    print("Chrome을 재시작해주세요.")
    input("Press Enter...")

if __name__ == "__main__":
    main()
