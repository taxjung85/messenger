"""
Chrome Native Messaging Host
- 거래처 폴더 열기
- 다운로드 파일을 거래처 폴더로 이동
"""
import sys, json, struct, subprocess, os, shutil, glob, time, zipfile, urllib.request, tempfile

def read_message():
    raw = sys.stdin.buffer.read(4)
    if not raw or len(raw) < 4:
        return None
    length = struct.unpack('=I', raw)[0]
    data = sys.stdin.buffer.read(length).decode('utf-8')
    return json.loads(data)

def send_message(msg):
    encoded = json.dumps(msg, ensure_ascii=False).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

def find_client_folder(base_path, client_code):
    if not base_path or not client_code:
        return None
    pattern = os.path.join(base_path, client_code + "_*")
    folders = [m for m in glob.glob(pattern) if os.path.isdir(m)]
    return folders[0] if folders else None

def main():
    msg = read_message()
    if not msg:
        return
    action = msg.get('action')

    if action == 'open_folder':
        base_path = msg.get('basePath', '')
        client_code = msg.get('clientCode', '')
        folder = find_client_folder(base_path, client_code)
        if folder:
            subprocess.Popen(['explorer', folder])
            send_message({'success': True, 'path': folder})
        else:
            send_message({'success': False, 'error': client_code + ' 폴더 없음'})

    elif action == 'move_file':
        src = msg.get('src', '')
        base_path = msg.get('basePath', '')
        client_code = msg.get('clientCode', '')
        filename = msg.get('filename', '')
        folder = find_client_folder(base_path, client_code)
        if not folder:
            send_message({'success': False, 'error': client_code + ' 폴더 없음'})
            return
        dst = os.path.join(folder, filename)
        try:
            for _ in range(10):
                if os.path.exists(src):
                    break
                time.sleep(0.5)
            if not os.path.exists(src):
                send_message({'success': False, 'error': '원본 파일 없음: ' + src})
                return
            shutil.move(src, dst)
            send_message({'success': True, 'path': dst})
        except Exception as e:
            send_message({'success': False, 'error': str(e)})

    elif action == 'update':
        download_url = msg.get('downloadUrl', '')
        target_dir = msg.get('targetDir', r'C:\extension')
        if not download_url:
            send_message({'success': False, 'error': 'downloadUrl 없음'})
            return
        try:
            tmp = tempfile.mktemp(suffix='.zip')
            urllib.request.urlretrieve(download_url, tmp)
            if os.path.exists(target_dir):
                shutil.rmtree(target_dir)
            with zipfile.ZipFile(tmp, 'r') as zf:
                zf.extractall(os.path.dirname(target_dir))
            os.remove(tmp)
            send_message({'success': True, 'path': target_dir})
        except Exception as e:
            send_message({'success': False, 'error': str(e)})

    elif action == 'ping':
        send_message({'success': True, 'message': 'pong'})
    else:
        send_message({'success': False, 'error': 'unknown action'})

if __name__ == '__main__':
    main()
