/**
 * Platform authorization, verified at the plugin's API boundary.
 *
 * The plugin sits between the settings page and a closed-source child, so the
 * things worth proving are the boundaries:
 *
 *  * **Capability negotiation** — the UI must learn from the child which flows
 *    exist, because the installed macOS build has no 华为 tools or routes at all.
 *  * **The plugin is a translator, not an authority** — it must not invent a QR
 *    for a rejected user code, must not treat a verification-code retry as a
 *    failure, and must pass the child's own words through.
 *  * **Credentials** — they go to the child and nowhere else: not into the log
 *    buffer, not back in a response, and not reachable from another origin.
 *
 * The fake child here speaks both upstream surfaces (MCP `tools/call` and the
 * 华为 REST routes) with scripted answers, so every branch is reachable without
 * a real account. Usage: `node scripts/check-platform-auth.mjs`
 */

import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..')

const failures = []
let checks = 0

function check(name, condition, detail = '') {
  checks += 1
  const ok = condition === true
  if (!ok) failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`)
  return ok
}

/** The password used throughout; it must never surface outside the child call. */
const SECRET = 'sup3rs3cret-Pa55w0rd'

async function main() {
  const { GatewayRuntime } = await import(join(projectRoot, 'lib', 'runtime.js'))
  const { createApiHandler } = await import(join(projectRoot, 'lib', 'api.js'))

  // ── 假子进程：MCP + 华为 REST，两套接口都按真实形状答 ──────────────
  const seen = { toolCalls: [], tuyaPolls: 0, callbackCode: null }
  const TOOLS = [
    'auth/platforms',
    'auth/tuya_qr',
    'auth/tuya_qr_status',
    'auth/tuya_logout',
    'auth/midea_login',
    'auth/midea_logout',
    'auth/ewelink_login',
    'auth/ewelink_logout',
    'xiaomi/auth_url',
    'xiaomi/auth_callback',
    'auth/huawei_login',
    'auth/huawei_challenge',
    'auth/huawei_logout',
    // Not auth, but a real child advertises 76 tools; the filter must ignore them.
    'device/list',
  ].map((name) => ({ name, description: `${name} 说明`, inputSchema: { type: 'object', properties: {} } }))

  const toolReply = (payload) => ({ result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } })

  function callTool(name, args) {
    seen.toolCalls.push({ name, args })
    switch (name) {
      case 'auth/platforms':
        return toolReply([
          { platform_id: 'xiaomi', platform_name: '米家', authenticated: true, auth_status: { cloud_server: 'cn' } },
          { platform_id: 'tuya', platform_name: '涂鸦', authenticated: false, auth_status: {} },
          { platform_id: 'midea', platform_name: '美的', authenticated: false, auth_status: {} },
          { platform_id: 'ewelink', platform_name: '易微联', authenticated: false, auth_status: {} },
        ])
      case 'auth/tuya_qr':
        if (args.user_code === 'LOCKEDCODE') {
          // 真实形态：登录类工具受授权门禁，子进程用 isError + capability_denied 回答。
          return {
            result: {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'capability_denied', message: '涂鸦试用已过期' }) }],
            },
          }
        }
        return args.user_code === 'GOODCODE'
          ? toolReply({ success: true, qr_url: 'tuyaSmart--qrLogin/?token=FAKEQRTOKEN1234567', token: 'FAKEQRTOKEN1234567', expire_time: 300 })
          : toolReply({ code: 'USERCODE_INCORRECT', error: 'User Code Incorrect', success: false })
      case 'auth/tuya_qr_status':
        seen.tuyaPolls += 1
        return toolReply(seen.tuyaPolls < 2 ? { success: true, status: 'pending' } : { success: true, status: 'authorized', uid: 'tuya-uid-9' })
      case 'auth/tuya_logout':
      case 'auth/midea_logout':
      case 'auth/ewelink_logout':
        return toolReply({ success: true, message: `${name} 已退出` })
      case 'auth/huawei_login':
        if (args.password !== SECRET) return toolReply({ success: false, device_count: 0, auth_status: { authenticated: false } })
        if (args.account === 'needcode@example.com') {
          return toolReply({
            success: false,
            device_count: 0,
            auth_status: { authenticated: false, pending_challenge: true, challenge_name: '138****8888', challenge_type: 'device' },
            message: '需调用 auth/huawei_challenge 提交两步验证码',
          })
        }
        return toolReply({ success: true, device_count: 3, auth_status: { authenticated: true, user_id: 'hw-uid' } })
      case 'auth/huawei_challenge':
        if (args.code === '123456') return toolReply({ success: true, user_id: 'hw-uid', account: '13800000000' })
        // 关键分支：验证码已通过、只是换令牌失败，会话已保留。
        if (args.code === 'RETRY') {
          return toolReply({
            success: false,
            error: '交换 HMS Lite Token 失败',
            retry_without_code: true,
            hint: '验证码已验证通过且会话已保留，可调用 refresh 重试 HMS-Lite 交换，无需新的验证码',
          })
        }
        return toolReply({ success: false, error: '验证码不正确' })
      case 'auth/huawei_logout':
        return toolReply({ success: true, message: '华为平台已退出' })
      case 'auth/midea_login':
        return toolReply(args.password === SECRET ? { success: true, device_count: 2, auth_status: { cloud: args.cloud } } : { success: false, device_count: 0, auth_status: {} })
      case 'auth/ewelink_login':
        return toolReply(args.password === SECRET ? { success: true, device_count: 3, auth_status: {} } : { success: false, device_count: 0, auth_status: {} })
      case 'xiaomi/auth_url':
        return toolReply({ url: `https://account.xiaomi.com/oauth2/authorize?region=${args.region ?? 'cn'}`, region: args.region ?? 'cn', redirect_uri: 'http://127.0.0.1:38080/auth/browser-callback', auto_callback: true })
      case 'xiaomi/auth_callback':
        seen.callbackCode = args.code
        return toolReply(args.code === 'THE-REAL-CODE' ? { success: true, message: 'Authorization successful', region: args.region ?? 'cn' } : { success: false, error: 'Authorization failed' })
      default:
        return { error: { message: `未知工具 ${name}` } }
    }
  }

  const child = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const json = (payload, status = 200) => {
        const text = JSON.stringify(payload)
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
        res.end(text)
      }
      if (url.pathname === '/api/v1/platform/xiaomi/logout') {
        return json({ code: 0, data: { success: true, message: '米家已退出' } })
      }
      if (url.pathname === '/mcp/http') {
        const message = JSON.parse(body)
        if (message.method === 'tools/list') return json({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })
        if (message.method === 'tools/call') {
          const reply = callTool(message.params.name, message.params.arguments ?? {})
          return json({ jsonrpc: '2.0', id: message.id, ...reply })
        }
        return json({ jsonrpc: '2.0', id: message.id, error: { message: 'method not found' } })
      }
      res.writeHead(404).end()
    })
  })
  await new Promise((resolve) => child.listen(0, '127.0.0.1', resolve))
  const childPort = child.address().port

  // ── 插件宿主：真实 GatewayRuntime + 真实 API handler，挂在真实端口上 ──
  const root = mkdtempSync(join(tmpdir(), 'fg-auth-'))
  writeFileSync(
    join(root, 'state.json'),
    JSON.stringify({
      schemaVersion: 1,
      root,
      currentVersion: '9.9.9',
      lastKnownGood: '9.9.9',
      pending: null,
      server: { port: childPort, effectivePort: childPort, autoStart: true },
      facade: { port: 0 },
      flags: {},
    }),
  )
  const runtime = new GatewayRuntime({ version: '9.9.9', root })
  const handler = createApiHandler({ runtime, version: '9.9.9' })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/dsh-feyagate`

  /** Call the plugin's own API the way the settings page does. */
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: base.replace('/dsh-feyagate', ''), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
    return { status: response.status, payload, text }
  }
  const post = (path, body, headers) => call('POST', path, body, headers)

  try {
    console.log('\n== 平台授权：能力协商 ==')
    const caps = await call('GET', '/auth/capabilities')
    const data = caps.payload?.data ?? {}
    check('GET /auth/capabilities 返回 200', caps.status === 200)
    check('报告子进程可达', data.childReachable === true)
    check(
      '工具清单只保留本 UI 会驱动的授权工具（13 个，device/list 被过滤）',
      Array.isArray(data.tools) && data.tools.length === 13 && !data.tools.includes('device/list'),
      `${(data.tools ?? []).length} 个`,
    )
    check('华为也走 MCP（与桌面端同一组工具）', (data.tools ?? []).includes('auth/huawei_login'))
    check('平台状态直接复用 auth/platforms', (data.platforms ?? []).length === 4 && data.platforms[0].platformName === '米家')

    console.log('\n== 涂鸦：二维码与扫码 ==')
    const qr = await post('/auth/tuya/qr', { userCode: 'GOODCODE' })
    const ticket = qr.payload?.data ?? {}
    check('生成二维码返回 200', qr.status === 200, JSON.stringify(qr.payload).slice(0, 80))
    check('返回可直接扫码的载荷', ticket.payloadUrl === 'tuyaSmart--qrLogin/?token=FAKEQRTOKEN1234567', String(ticket.payloadUrl))
    check('返回本插件的图片路由（根相对）', ticket.imageUrl === '/dsh-feyagate/auth/tuya/qr.png?token=FAKEQRTOKEN1234567', String(ticket.imageUrl))
    check('返回文本兜底路由与有效期', String(ticket.textUrl).endsWith('/auth/tuya/qr.txt?token=FAKEQRTOKEN1234567') && ticket.expireSeconds === 300)

    const badCode = await post('/auth/tuya/qr', { userCode: 'WRONGCODE' })
    check('用户代码不对时返回 400（不伪造二维码）', badCode.status === 400 && badCode.payload?.data === undefined, `${badCode.status}`)
    check(
      '错误里告诉用户去哪找用户代码（上游原文也保留）',
      String(badCode.payload?.error).includes('用户代码不正确') && String(badCode.payload?.error).includes('User Code Incorrect'),
      String(badCode.payload?.error).slice(0, 90),
    )

    const missing = await post('/auth/tuya/qr', {})
    check('缺用户代码时返回 400', missing.status === 400 && String(missing.payload?.error).includes('请填写'))

    const locked = await post('/auth/tuya/qr', { userCode: 'LOCKEDCODE' })
    check(
      '★ 授权门禁（capability_denied）给出 403 与「去授权标签看试用」的指引，而不是"密码错了"',
      locked.status === 403 && String(locked.payload?.error).includes('当前授权不允许') && String(locked.payload?.error).includes('涂鸦试用已过期'),
      `${locked.status} ${String(locked.payload?.error).slice(0, 80)}`,
    )

    const pollsBefore = seen.tuyaPolls
    const status = await post('/auth/tuya/status', { token: 'FAKEQRTOKEN1234567', userCode: 'GOODCODE' })
    check('扫码等待由服务端完成：一次请求就等到 authorized', status.payload?.data?.status === 'authorized', JSON.stringify(status.payload?.data))
    check('等待期间确实在轮询上游（不是一次就问完）', seen.tuyaPolls - pollsBefore >= 2, `问了 ${seen.tuyaPolls - pollsBefore} 次`)
    check('返回 uid 供界面显示', status.payload?.data?.uid === 'tuya-uid-9')

    const badToken = await post('/auth/tuya/status', { token: 'not a token', userCode: 'GOODCODE' })
    check('形状不合法的 token 被挡在自己的门口（400）', badToken.status === 400)

    console.log('\n== 美的 / 易微联：账号口令 ==')
    const midea = await post('/auth/midea/login', { account: '13800000000', password: SECRET, cloud: 'msmart' })
    check('美的登录成功并回报设备数', midea.status === 200 && midea.payload?.data?.deviceCount === 2, JSON.stringify(midea.payload?.data))
    check('云端类型原样传给子进程', seen.toolCalls.at(-1).args.cloud === 'msmart')

    const mideaBad = await post('/auth/midea/login', { account: '13800000000', password: 'wrong' })
    check('美的密码错误时返回 400 且带可读原因', mideaBad.status === 400 && String(mideaBad.payload?.error).includes('美的登录失败'), String(mideaBad.payload?.error))

    const mideaMissing = await post('/auth/midea/login', { account: '13800000000' })
    check('美的缺密码时返回 400', mideaMissing.status === 400 && String(mideaMissing.payload?.error).includes('请填写美的密码'))

    const mideaCloud = await post('/auth/midea/login', { account: 'a', password: 'b', cloud: 'unknown' })
    check('未知云端类型被挡下（不给子进程乱传）', mideaCloud.status === 400 && String(mideaCloud.payload?.error).includes('未知的美的云端类型'))

    const ewelink = await post('/auth/ewelink/login', { email: 'me@example.com', password: SECRET, countryCode: '+86' })
    check('易微联登录成功', ewelink.status === 200 && ewelink.payload?.data?.deviceCount === 3)
    const ewelinkCountry = await post('/auth/ewelink/login', { email: 'me@example.com', password: SECRET, countryCode: '中国' })
    check('国家代码格式错误时给出 400（而不是让上游静默失败）', ewelinkCountry.status === 400 && String(ewelinkCountry.payload?.error).includes('国家代码格式不正确'))

    console.log('\n== 米家：两步 OAuth ==')
    const url = await post('/auth/xiaomi/url', { region: 'sg' })
    check('返回授权地址', url.status === 200 && String(url.payload?.data?.url).startsWith('https://account.xiaomi.com/'))
    check('授权地址带自动回调标记（redirect_uri 指向本机 browser-callback）', url.payload?.data?.autoCallback === true)
    const urlBadRegion = await post('/auth/xiaomi/url', { region: 'mars' })
    check('未知区域被挡下（子进程会照单全收）', urlBadRegion.status === 400 && String(urlBadRegion.payload?.error).includes('未知的小米区域'))

    seen.callbackCode = null
    const pastedUrl = 'https://127.0.0.1/?code=THE-REAL-CODE&state=abc'
    const callback = await post('/auth/xiaomi/callback', { input: pastedUrl, region: 'sg' })
    check('粘贴整段回调地址即可完成授权', callback.status === 200, JSON.stringify(callback.payload).slice(0, 90))
    check('★ 插件把 URL 里的 code 抠出来再给子进程', seen.callbackCode === 'THE-REAL-CODE', String(seen.callbackCode))

    const bareCode = await post('/auth/xiaomi/callback', { input: 'THE-REAL-CODE' })
    check('只粘 code 也接受', bareCode.status === 200)
    const junk = await post('/auth/xiaomi/callback', { input: 'https://127.0.0.1/?state=abc' })
    check('没有 code 时给出可操作的 400', junk.status === 400 && String(junk.payload?.error).includes('没有在粘贴的内容里找到 code'), String(junk.payload?.error).slice(0, 80))
    const rejected = await post('/auth/xiaomi/callback', { input: 'https://127.0.0.1/?code=USED-CODE' })
    check('code 被上游拒绝时如实报 400', rejected.status === 400 && String(rejected.payload?.error).includes('米家授权失败'))

    console.log('\n== 华为：两步登录与「免验证码重试」 ==')
    const huaweiDirect = await post('/auth/huawei/login', { account: '13800000000', password: SECRET })
    check(
      '第一步直接认证成功',
      huaweiDirect.status === 200 && huaweiDirect.payload?.data?.authenticated === true && huaweiDirect.payload?.data?.needCode === false,
      JSON.stringify(huaweiDirect.payload?.data),
    )

    const huawei = await post('/auth/huawei/login', { account: 'needcode@example.com', password: SECRET })
    check('需要两步验证时返回 needCode（等验证码）', huawei.status === 200 && huawei.payload?.data?.needCode === true, JSON.stringify(huawei.payload?.data))
    check('把上游「验证码发往哪里」带给界面', huawei.payload?.data?.challengeName === '138****8888')

    const wrongPassword = await post('/auth/huawei/login', { account: '13800000000', password: 'nope' })
    check(
      '华为密码错误返回 400 与可读原因',
      wrongPassword.status === 400 && String(wrongPassword.payload?.error).includes('请核对账号与密码'),
      `${wrongPassword.status} ${String(wrongPassword.payload?.error).slice(0, 70)}`,
    )

    const challengeOk = await post('/auth/huawei/challenge', { code: '123456' })
    check('提交验证码后已认证', challengeOk.status === 200 && challengeOk.payload?.data?.authenticated === true)

    const challengeRetry = await post('/auth/huawei/challenge', { code: 'RETRY' })
    check(
      '★ retry_without_code 不当成失败（不白费用户一个验证码）',
      challengeRetry.status === 200 && challengeRetry.payload?.data?.retryWithoutCode === true && challengeRetry.payload?.data?.authenticated === false,
      JSON.stringify(challengeRetry.payload?.data),
    )
    check('并把上游的 hint 一并带给界面', String(challengeRetry.payload?.data?.message).includes('会话已保留'))
    const challengeBad = await post('/auth/huawei/challenge', { code: '000000' })
    check('真·验证码错误仍是 400', challengeBad.status === 400 && String(challengeBad.payload?.error).includes('验证码不正确'))
    check('华为登录确实用了 MCP 工具', seen.toolCalls.some((entry) => entry.name === 'auth/huawei_login'))

    console.log('\n== 退出登录 ==')
    for (const platform of ['tuya', 'midea', 'ewelink', 'huawei']) {
      const out = await post('/auth/logout', { platform })
      check(`${platform} 退出登录成功`, out.status === 200, `${out.status} ${out.text.slice(0, 60)}`)
    }
    const xiaomiOut = await post('/auth/logout', { platform: 'xiaomi' })
    check(
      '米家退出登录成功（走后台服务 REST /api/v1/platform/xiaomi/logout）',
      xiaomiOut.status === 200 && String(xiaomiOut.payload?.data?.message ?? xiaomiOut.payload?.data).includes('米家已退出'),
      `${xiaomiOut.status} ${xiaomiOut.text.slice(0, 60)}`,
    )
    const unknownOut = await post('/auth/logout', { platform: 'nope' })
    check('未知平台返回 404（并提示缺参数）', unknownOut.status === 404 && (await post('/auth/logout', {})).status === 400)

    console.log('\n== 凭据边界（本功能最容易出错的地方）==')
    check(
      '★ 密码没有进入插件日志缓冲（日志会显示在设置页里）',
      runtime.log.tail(2000).every((line) => !JSON.stringify(line).includes(SECRET)),
    )
    const serializedState = JSON.stringify(runtime.state.get())
    check('密码没有进入插件状态文件（state.json 里没有）', !serializedState.includes(SECRET))
    const logs = await call('GET', '/logs?limit=2000')
    check('密码没有出现在 /logs 接口的返回里', !logs.text.includes(SECRET))
    const overview = await call('GET', '/account/overview')
    check('密码没有回显在账号总览里', !overview.text.includes(SECRET))

    const foreign = await post('/auth/midea/login', { account: 'a', password: 'b' }, { Origin: 'http://evil.example' })
    check('来自其他 Origin 的登录请求被拒绝（403）', foreign.status === 403, `${foreign.status} ${foreign.text.slice(0, 60)}`)
    const foreignLogout = await post('/auth/logout', { platform: 'tuya' }, { Origin: 'http://evil.example' })
    check('退出登录同样受 Origin 守卫', foreignLogout.status === 403)

    console.log('\n== 子进程不在时的说法 ==')
    await new Promise((resolve) => child.close(resolve))
    const downCaps = await call('GET', '/auth/capabilities')
    check('服务未运行时 capabilities 如实报告不可达', downCaps.payload?.data?.childReachable === false)
    const downQr = await post('/auth/tuya/qr', { userCode: 'GOODCODE' })
    check('服务未运行时登录返回 503 与可操作提示', downQr.status === 503 && String(downQr.payload?.error).includes('请先在「服务」标签里启动'), `${downQr.status}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => child.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }

  console.log(`\n== 结果：${checks - failures.length}/${checks} 通过 ==`)
  if (failures.length > 0) {
    console.error('\n失败项：')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
  } else {
    console.log('全部通过。')
  }
}

await main()
