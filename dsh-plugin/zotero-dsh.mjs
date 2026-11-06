#!/usr/bin/env -S node --no-warnings
// zotero-dsh — terminal chat client for the local DSH ↔ Zotero bridge.
// Requires no npm packages. Uses ~/.dsh/zotero-bridge.json for discovery.

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'

// Node fetch uses the ambient proxy on some macOS setups. This client talks
// only to localhost, so bypass it explicitly.
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  delete process.env[key]
}

const endpointFile = join(homedir(), '.dsh', 'zotero-bridge.json')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function endpoints() {
  try {
    const config = JSON.parse(await readFile(endpointFile, 'utf8'))
    return {
      origin: config.origin,
      openUrl: config.openUrl || config.origin,
      chat: config.chat || `${config.origin}/zotero-bridge/chat`,
      status: config.status || `${config.origin}/zotero-bridge/status`,
    }
  } catch {
    throw new Error('找不到 DSH 端点。请先启动 DeepSeek Harness 并启用 Zotero bridge 插件。')
  }
}

async function postMessage(message, title) {
  const ep = await endpoints()
  const response = await fetch(ep.chat, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, title }),
    signal: AbortSignal.timeout(20000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return { ...body, ep }
}

async function waitReply(ep, timeoutMs = 180000) {
  const started = Date.now()
  let previous = ''
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(ep.status, { signal: AbortSignal.timeout(10000) })
      const body = await response.json()
      if (body.reply && body.reply !== previous) {
        previous = body.reply
        if (!body.running) return body.reply
      }
    } catch { /* DSH may be restarting */ }
    await sleep(1200)
  }
  throw new Error('等待 DSH 回复超时；请打开 DSH 的 zotero-bridge 会话查看。')
}

function openGUI(url) {
  if (!url) return
  spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--open')) {
    openGUI((await endpoints()).openUrl)
    return
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法：\n  zotero-dsh "你的问题"    发送一次问题并等待回复\n  zotero-dsh              进入连续聊天（/open 打开 DSH，/exit 退出）\n  zotero-dsh --open       只打开 DSH 页面')
    return
  }
  if (args.length) {
    const result = await postMessage(args.join(' '), '终端提问')
    console.log(`已发送到会话 ${result.sessionId}，等待回复…\n`)
    console.log(await waitReply(result.ep))
    return
  }

  console.log('Zotero ↔ DSH 连续聊天。输入 /open 打开 DSH，/exit 或 Ctrl-D 退出。')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\n你> ' })
  rl.prompt()
  for await (const line of rl) {
    const text = line.trim()
    if (!text) { rl.prompt(); continue }
    if (text === '/exit' || text === '/quit') break
    if (text === '/open') { openGUI((await endpoints()).openUrl); rl.prompt(); continue }
    try {
      const result = await postMessage(text, '终端提问')
      console.log('DSH 思考中…\n')
      console.log('DSH> ' + (await waitReply(result.ep)))
    } catch (error) {
      console.error('错误：' + error.message)
    }
    rl.prompt()
  }
  rl.close()
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
