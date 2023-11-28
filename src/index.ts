import { command_header, generateSignature, getPrivacyName } from './utils'
import { bark, serverChan } from './message_send'
import { BINDING_URL, CRED_CODE_URL, SKLAND_ATTENDANCE_URL, SKLAND_AUTH_URL, SKLAND_BOARD_IDS, SKLAND_BOARD_NAME_MAPPING, SKLAND_CHECKIN_URL } from './constant'
import type { AttendanceResponse, AuthResponse, BindingResponse, CredResponse, SklandBoard } from './types'

async function auth(token: string) {
  const response = await fetch(SKLAND_AUTH_URL, {
    method: 'POST',
    headers: command_header,
    body: JSON.stringify({
      appCode: '4ca99fa6b56cc2ba',
      token,
      type: 0,
    }),
  })
  const data = await response.json() as AuthResponse
  if (data.status !== 0 || !data.data)
    throw new Error(`登录获取 cred 错误:${data.msg}`)

  return data.data
}

async function signIn(grant_code: string) {
  const response = await fetch(CRED_CODE_URL, {
    method: 'POST',
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
    }, command_header),
    body: JSON.stringify({
      code: grant_code,
      kind: 1,
    }),
  })
  const data = await response.json() as CredResponse

  if (data.code !== 0)
    throw new Error(`登录获取 cred 错误:${data.message}`)

  return data.data
}

async function getBinding(cred: string, token: string) {
  const url = new URL(BINDING_URL)
  const [sign, headers] = generateSignature(token, url)
  const response = await fetch(BINDING_URL, {
    headers: Object.assign(headers, { sign, cred }),
  })
  const data = await response.json() as BindingResponse
  if (data.code !== 0)
    throw new Error(`获取绑定角色错误:${data.message}`)

  return data.data
}

/** 登岛检票 */
async function checkIn(cred: string, token: string, id: SklandBoard) {
  const url = new URL(SKLAND_CHECKIN_URL)
  const body = { gameId: id.toString() }
  const [sign, cryptoHeaders] = generateSignature(token, url, body)
  const headers = Object.assign(cryptoHeaders, { sign, cred, 'Content-Type': 'application/json;charset=utf-8' }, command_header)
  const response = await fetch(
    url,
    { method: 'POST', headers, body: JSON.stringify(body) },
  )
  const data = await response.json() as { code: number, message: string, timestamp: string }
  return data
}
/** 明日方舟每日签到 */
async function attendance(cred: string, token: string, body: { uid: string, gameId: string }) {
  const url = new URL(SKLAND_ATTENDANCE_URL)
  const [sign, cryptoHeaders] = generateSignature(token, url, body)
  const headers = Object.assign(cryptoHeaders, { sign, cred, 'Content-Type': 'application/json;charset=utf-8' }, command_header)

  const response = await fetch(
    SKLAND_ATTENDANCE_URL,
    { method: 'POST', headers, body: JSON.stringify(body) },
  )
  const data = await response.json() as AttendanceResponse

  return data
}

interface Options {
  /** server 酱推送功能的启用，false 或者 server 酱的token */
  withServerChan?: false | string
  /** bark 推送功能的启用，false 或者 bark 的 URL */
  withBark?: false | string
}

export async function doAttendanceForAccount(token: string, options: Options) {
  const { code } = await auth(token)
  const { cred, token: signToken } = await signIn(code)
  const { list } = await getBinding(cred, signToken)

  const createCombinePushMessage = () => {
    const messages: string[] = []
    let hasError = false
    const logger = (message: string, error?: boolean) => {
      messages.push(message)
      console[error ? 'error' : 'log'](message)
      if (error && !hasError)
        hasError = true
    }
    const push
            = async () => {
              if (options.withServerChan) {
                await serverChan(
                  options.withServerChan,
                        `【森空岛每日签到】`,
                        messages.join('\n\n'),
                )
              }
              if (options.withBark) {
                await bark(
                  options.withBark,
                        `【森空岛每日签到】`,
                        messages.join('\n\n'),
                )
              }
              // quit with error
              if (hasError)
                process.exit(1)
            }
    const add = (message: string) => {
      messages.push(message)
    }
    return [logger, push, add] as const
  }

  const [combineMessage, excutePushMessage, addMessage] = createCombinePushMessage()

  addMessage(`# 森空岛每日签到 \n\n> ${new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date())}`)
  addMessage('## 森空岛各版面每日检票')
  await Promise.all(SKLAND_BOARD_IDS.map(async (id) => {
    const data = await checkIn(cred, signToken, id)
    const name = SKLAND_BOARD_NAME_MAPPING[id]
    if (data.message === 'OK' && data.code === 0) {
      combineMessage(`版面【${name}】登岛检票成功`)
    }
    else {
      // 登岛检票 最后不会以错误结束进程
      combineMessage(`版面【${name}】登岛检票失败, 错误信息: ${data.message}`)
    }
  }))

  addMessage('## 明日方舟签到')
  let successAttendance = 0
  const characterList = list.map(i => i.bindingList).flat()
  await Promise.all(characterList.map(async (character) => {
    const data = await attendance(cred, signToken, {
      uid: character.uid,
      gameId: character.channelMasterId,
    })
    console.log(`将签到第${successAttendance + 1}个角色`)
    if (data.code === 0 && data.message === 'OK') {
      const msg = `${(Number(character.channelMasterId) - 1) ? 'B 服' : '官服'}角色 ${getPrivacyName(character.nickName)} 签到成功${`, 获得了${data.data.awards.map(a => `「${a.resource.name}」${a.count}个`).join(',')}`}`
      combineMessage(msg)
      successAttendance++
    }
    else {
      const msg = `${(Number(character.channelMasterId) - 1) ? 'B 服' : '官服'}角色 ${getPrivacyName(character.nickName)} 签到失败${`, 错误消息: ${data.message}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``}`
      combineMessage(msg, true)
    }
  }))
  combineMessage(`成功签到${successAttendance}个角色`)
  await excutePushMessage()
}