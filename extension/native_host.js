#!/usr/bin/env node
/**
 * Chrome Native Messaging Host
 * - 거래처 폴더 열기
 * - 다운로드 파일을 거래처 폴더로 이동
 */
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

function readMessage() {
  return new Promise((resolve) => {
    let lenBuf = Buffer.alloc(0);
    function onData(chunk) {
      lenBuf = Buffer.concat([lenBuf, chunk]);
      if (lenBuf.length >= 4) {
        process.stdin.removeListener("data", onData);
        const msgLen = lenBuf.readUInt32LE(0);
        let msgBuf = lenBuf.slice(4);
        if (msgBuf.length >= msgLen) {
          resolve(JSON.parse(msgBuf.slice(0, msgLen).toString("utf-8")));
        } else {
          const remaining = msgLen - msgBuf.length;
          const chunks = [msgBuf];
          function onMore(c) {
            chunks.push(c);
            const total = chunks.reduce((s, b) => s + b.length, 0);
            if (total >= msgLen) {
              process.stdin.removeListener("data", onMore);
              resolve(JSON.parse(Buffer.concat(chunks).slice(0, msgLen).toString("utf-8")));
            }
          }
          process.stdin.on("data", onMore);
        }
      }
    }
    process.stdin.on("data", onData);
  });
}

function sendMessage(msg) {
  const encoded = Buffer.from(JSON.stringify(msg), "utf-8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(encoded.length, 0);
  process.stdout.write(lenBuf);
  process.stdout.write(encoded);
}

function findClientFolder(basePath, clientCode) {
  if (!basePath || !clientCode) return null;
  try {
    const entries = fs.readdirSync(basePath);
    const match = entries.find((e) => {
      if (!e.startsWith(clientCode + "_") && !e.startsWith(clientCode + " ")) return false;
      return fs.statSync(path.join(basePath, e)).isDirectory();
    });
    return match ? path.join(basePath, match) : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const msg = await readMessage();
  const action = msg.action;

  if (action === "open_folder") {
    const folder = findClientFolder(msg.basePath, msg.clientCode);
    if (folder) {
      execFile("explorer", [folder]);
      sendMessage({ success: true, path: folder });
    } else {
      sendMessage({ success: false, error: msg.clientCode + " 폴더 없음" });
    }
  } else if (action === "move_file") {
    const folder = findClientFolder(msg.basePath, msg.clientCode);
    if (!folder) {
      sendMessage({ success: false, error: msg.clientCode + " 폴더 없음" });
      return;
    }
    const dst = path.join(folder, msg.filename);
    // 다운로드 완료 대기 (최대 5초)
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(msg.src)) break;
      await sleep(500);
    }
    if (!fs.existsSync(msg.src)) {
      sendMessage({ success: false, error: "원본 파일 없음: " + msg.src });
      return;
    }
    try {
      fs.copyFileSync(msg.src, dst);
      fs.unlinkSync(msg.src);
      sendMessage({ success: true, path: dst });
    } catch (e) {
      sendMessage({ success: false, error: e.message });
    }
  } else if (action === "ping") {
    sendMessage({ success: true, message: "pong" });
  } else {
    sendMessage({ success: false, error: "unknown action" });
  }
}

main().catch((e) => {
  sendMessage({ success: false, error: e.message });
});
