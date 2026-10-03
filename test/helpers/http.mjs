/**
 * 端点测试的请求/响应替身 —— **只有这一份**。
 *
 * 以前三个测试文件各抄一套（plugin / settings / dsh-integration），抄完就开始各自演化：
 * settings 那份支持自定义 url/headers，plugin 那份把 url 写死成 CONFIG_ENDPOINT，
 * 于是「从一个文件搬到另一个文件」行为并不一样。共享之后语义只有一种。
 *
 * 注意 `host` 默认是回环地址：端点的门禁要求 Host 是地址字面量或 localhost
 * （见 src/pet-endpoint.js 的 guardLocalRequest），真实 HTTP/1.1 一定有 Host。
 */

export const CONFIG_PATH = '/plugins/dsh-assistant/config'

/**
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {string} [options.address] socket 源地址（默认回环）
 * @param {object} [options.body] JSON body（自动序列化）
 * @param {object} [options.headers] 额外请求头（会覆盖默认的 host）
 * @param {string} [options.url]
 */
export function fakeRequest({
  method = 'GET',
  address = '127.0.0.1',
  body,
  headers = {},
  url = CONFIG_PATH,
} = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:43120', ...headers },
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

export function fakeResponse() {
  const state = { status: 0, body: '' }
  return {
    state,
    writeHead(status) { state.status = status },
    end(payload) { state.body = payload ?? '' },
  }
}
