import { PassThrough } from "stream";
import path from 'path';
import _ from 'lodash';
import mime from 'mime';
import axios, { AxiosResponse } from 'axios';

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from 'eventsource-parser'
import logger from '@/lib/logger.ts';
import util from '@/lib/util.ts';

// 模型名称
const MODEL_NAME = 'kimi';
// access_token有效期
const ACCESS_TOKEN_EXPIRES = 300;
// 最大重试次数
const MAX_RETRY_COUNT = 3;
// 重试延迟
const RETRY_DELAY = 5000;
// 伪装headers
const FAKE_HEADERS = {
  'Accept': '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Origin': 'https://kimi.moonshot.cn',
  'Cookie': util.generateCookie(),
  'R-Timezone': 'Asia/Shanghai',
  'Sec-Ch-Ua': '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
};
// 文件最大大小
const FILE_MAX_SIZE = 100 * 1024 * 1024;
// access_token映射
const accessTokenMap = new Map();
// access_token请求队列映射
const accessTokenRequestQueueMap: Record<string, Function[]> = {};

/**
 * 请求access_token
 * 
 * 使用refresh_token去刷新获得access_token
 * 
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function requestToken(refreshToken: string) {
  if (accessTokenRequestQueueMap[refreshToken])
    return new Promise(resolve => accessTokenRequestQueueMap[refreshToken].push(resolve));
  accessTokenRequestQueueMap[refreshToken] = [];
  logger.info(`Refresh token: ${refreshToken}`);
  const result = await (async () => {
    const result = await axios.get('https://kimi.moonshot.cn/api/auth/token/refresh', {
      headers: {
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Authorization: `Bearer ${refreshToken}`,
        'Cache-Control': 'no-cache',
        'Cookie': util.generateCookie(),
        Pragma: 'no-cache',
        Referer: 'https://kimi.moonshot.cn/',
        'Sec-Ch-Ua': '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      },
      timeout: 15000,
      validateStatus: () => true
    });
    const {
      access_token,
      refresh_token
    } = checkResult(result, refreshToken);
    const { id: userId } = await getUserInfo(access_token, refreshToken);
    return {
      userId,
      accessToken: access_token,
      refreshToken: refresh_token,
      refreshTime: util.unixTimestamp() + ACCESS_TOKEN_EXPIRES
    }
  })()
    .then(result => {
      if (accessTokenRequestQueueMap[refreshToken]) {
        accessTokenRequestQueueMap[refreshToken].forEach(resolve => resolve(result));
        delete accessTokenRequestQueueMap[refreshToken];
      }
      logger.success(`Refresh successful`);
      return result;
    })
    .catch(err => {
      if (accessTokenRequestQueueMap[refreshToken]) {
        accessTokenRequestQueueMap[refreshToken].forEach(resolve => resolve(err));
        delete accessTokenRequestQueueMap[refreshToken];
      }
      return err;
    });
  if (_.isError(result))
    throw result;
  return result;
}

/**
 * 获取缓存中的access_token
 * 
 * 避免短时间大量刷新token，未加锁，如果有并发要求还需加锁
 * 
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function acquireToken(refreshToken: string): Promise<any> {
  let result = accessTokenMap.get(refreshToken);
  if (!result) {
    result = await requestToken(refreshToken);
    accessTokenMap.set(refreshToken, result);
  }
  if (util.unixTimestamp() > result.refreshTime) {
    result = await requestToken(refreshToken);
    accessTokenMap.set(refreshToken, result);
  }
  return result;
}

/**
 * 获取用户信息
 * 
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function getUserInfo(accessToken: string, refreshToken: string) {
  const result = await axios.get('https://kimi.moonshot.cn/api/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Referer: 'https://kimi.moonshot.cn/',
      'X-Traffic-Id': `7${util.generateRandomString({ length: 18, charset: 'numeric' })}`,
      ...FAKE_HEADERS
    },
    timeout: 15000,
    validateStatus: () => true
  });
  return checkResult(result, refreshToken);
}

/**
 * 创建会话
 * 
 * 创建临时的会话用于对话补全
 * 
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function createConversation(name: string, refreshToken: string) {
  const {
    accessToken,
    userId
  } = await acquireToken(refreshToken);
  const result = await axios.post('https://kimi.moonshot.cn/api/chat', {
    is_example: false,
    name
  }, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Referer: 'https://kimi.moonshot.cn/',
      'X-Traffic-Id': userId,
      ...FAKE_HEADERS
    },
    timeout: 15000,
    validateStatus: () => true
  });
  const {
    id: convId
  } = checkResult(result, refreshToken);
  return convId;
}

/**
 * 移除会话
 * 
 * 在对话流传输完毕后移除会话，避免创建的会话出现在用户的对话列表中
 * 
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function removeConversation(convId: string, refreshToken: string) {
  const {
    accessToken,
    userId
  } = await acquireToken(refreshToken);
  const result = await axios.delete(`https://kimi.moonshot.cn/api/chat/${convId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Referer: `https://kimi.moonshot.cn/chat/${convId}`,
      'X-Traffic-Id': userId,
      ...FAKE_HEADERS
    },
    timeout: 15000,
    validateStatus: () => true
  });
  checkResult(result, refreshToken);
}

/**
 * prompt片段提交
 * 
 * @param query prompt
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function promptSnippetSubmit(query: string, refreshToken: string) {
  const {
    accessToken,
    userId
  } = await acquireToken(refreshToken);
  const result = await axios.post('https://kimi.moonshot.cn/api/prompt-snippet/instance', {
    "offset": 0,
    "size": 10,
    "query": query.replace('user:', '').replace('assistant:', '')
  }, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Referer: 'https://kimi.moonshot.cn/',
      'X-Traffic-Id': userId,
      ...FAKE_HEADERS
    },
    timeout: 15000,
    validateStatus: () => true
  });
  checkResult(result, refreshToken);
}

/**
 * 同步对话补全
 * 
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param useSearch 是否开启联网搜索
 * @param refConvId 引用会话ID
 * @param retryCount 重试次数
 */
async function createCompletion(model = MODEL_NAME, messages: any[], refreshToken: string, useSearch = true, refConvId?: string, retryCount = 0) {
  return (async () => {
    logger.info(messages);

    // 提取引用文件URL并上传kimi获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length ? await Promise.all(refFileUrls.map(fileUrl => uploadFile(fileUrl, refreshToken))) : [];

    // 伪装调用获取用户信息
    fakeRequest(refreshToken)
      .catch(err => logger.error(err));

    // 创建会话
    const convId = /[0-9a-zA-Z]{20}/.test(refConvId) ? refConvId : await createConversation("未命名会话", refreshToken);

    // 请求流
    const {
      accessToken,
      userId
    } = await acquireToken(refreshToken);
    const sendMessages = messagesPrepare(messages, !!refConvId);
    const result = await axios.post(`https://kimi.moonshot.cn/api/chat/${convId}/completion/stream`, {
      messages: sendMessages,
      refs,
      use_search: useSearch
    }, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Referer: `https://kimi.moonshot.cn/chat/${convId}`,
        'Priority': 'u=1, i',
        'X-Traffic-Id': userId,
        ...FAKE_HEADERS
      },
      // 120秒超时
      timeout: 120000,
      validateStatus: () => true,
      responseType: 'stream'
    });

    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const answer = await receiveStream(model, convId, result.data);
    logger.success(`Stream has completed transfer ${util.timestamp() - streamStartTime}ms`);

    // 异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
    // 如果引用会话将不会清除，因为我们不知道什么时候你会结束会话
    !refConvId && removeConversation(convId, refreshToken)
      .catch(err => console.error(err));
    promptSnippetSubmit(sendMessages[0].content, refreshToken)
      .catch(err => console.error(err));

    return answer;
  })()
    .catch(err => {
      if (retryCount < MAX_RETRY_COUNT) {
        logger.error(`Stream response error: ${err.message}`);
        logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
        return (async () => {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          return createCompletion(model, messages, refreshToken, useSearch, refConvId, retryCount + 1);
        })();
      }
      throw err;
    });
}

/**
 * 流式对话补全
 * 
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param useSearch 是否开启联网搜索
 * @param refConvId 引用会话ID
 * @param retryCount 重试次数
 */
async function createCompletionStream(model = MODEL_NAME, messages: any[], refreshToken: string, useSearch = true, refConvId?: string, retryCount = 0) {
  return (async () => {
    logger.info(messages);

    // 提取引用文件URL并上传kimi获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length ? await Promise.all(refFileUrls.map(fileUrl => uploadFile(fileUrl, refreshToken))) : [];

    // 伪装调用获取用户信息
    fakeRequest(refreshToken)
      .catch(err => logger.error(err));

    // 创建会话
    const convId = /[0-9a-zA-Z]{20}/.test(refConvId) ? refConvId : await createConversation("未命名会话", refreshToken);

    // 请求流
    const {
      accessToken,
      userId
    } = await acquireToken(refreshToken);
    const sendMessages = messagesPrepare(messages, !!refConvId);
    const result = await axios.post(`https://kimi.moonshot.cn/api/chat/${convId}/completion/stream`, {
      messages: sendMessages,
      refs,
      use_search: useSearch
    }, {
      // 120秒超时
      timeout: 120000,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Referer: `https://kimi.moonshot.cn/chat/${convId}`,
        'Priority': 'u=1, i',
        'X-Traffic-Id': userId,
        ...FAKE_HEADERS
      },
      validateStatus: () => true,
      responseType: 'stream'
    });
    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    return createTransStream(model, convId, result.data, () => {
      logger.success(`Stream has completed transfer ${util.timestamp() - streamStartTime}ms`);
      // 流传输结束后异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
      // 如果引用会话将不会清除，因为我们不知道什么时候你会结束会话
      !refConvId && removeConversation(convId, refreshToken)
        .catch(err => console.error(err));
      promptSnippetSubmit(sendMessages[0].content, refreshToken)
        .catch(err => console.error(err));
    });
  })()
    .catch(err => {
      if (retryCount < MAX_RETRY_COUNT) {
        logger.error(`Stream response error: ${err.message}`);
        logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
        return (async () => {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          return createCompletionStream(model, messages, refreshToken, useSearch, refConvId, retryCount + 1);
        })();
      }
      throw err;
    });
}

/**
 * 调用一些接口伪装访问
 * 
 * 随机挑一个
 * 
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function fakeRequest(refreshToken: string) {
  const {
    accessToken,
    userId
  } = await acquireToken(refreshToken);
  const options = {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Referer: `https://kimi.moonshot.cn/`,
      'X-Traffic-Id': userId,
      ...FAKE_HEADERS
    }
  };
  await [
    () => axios.get('https://kimi.moonshot.cn/api/user', options),
    () => axios.get('https://kimi.moonshot.cn/api/chat_1m/user/status', options),
    () => axios.post('https://kimi.moonshot.cn/api/chat/list', {
      offset: 0,
      size: 50
    }, options),
    () => axios.post('https://kimi.moonshot.cn/api/show_case/list', {
      offset: 0,
      size: 4,
      enable_cache: true,
      order: "asc"
    }, options)
  ][Math.floor(Math.random() * 4)]();
}

/**
 * 提取消息中引用的文件URL
 * 
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 */
function extractRefFileUrls(messages: any[]) {
  const urls = [];
  // 如果没有消息，则返回[]
  if (!messages.length) {
    return urls;
  }
  // 只获取最新的消息
  const lastMessage = messages[messages.length - 1];
  if (_.isArray(lastMessage.content)) {
    lastMessage.content.forEach(v => {
      if (!_.isObject(v) || !['file', 'image_url'].includes(v['type']))
        return;
      // kimi-free-api支持格式
      if (v['type'] == 'file' && _.isObject(v['file_url']) && _.isString(v['file_url']['url']))
        urls.push(v['file_url']['url']);
      // 兼容gpt-4-vision-preview API格式
      else if (v['type'] == 'image_url' && _.isObject(v['image_url']) && _.isString(v['image_url']['url']))
        urls.push(v['image_url']['url']);
    });
  }
  logger.info("本次请求上传：" + urls.length + "个文件");
  return urls;
}

/**
 * 消息预处理
 * 
 * 由于接口只取第一条消息，此处会将多条消息合并为一条，实现多轮对话效果
 * user:旧消息1
 * assistant:旧消息2
 * user:新消息
 * 
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param isRefConv 是否为引用会话
 */
function messagesPrepare(messages: any[], isRefConv = false) {
  let content;
  if (isRefConv || messages.length < 2) {
    content = messages.reduce((content, message) => {
      if (_.isArray(message.content)) {
        return message.content.reduce((_content, v) => {
          if (!_.isObject(v) || v['type'] != 'text') return _content;
          return _content + `${v["text"] || ""}\n`;
        }, content);
      }
      return content += `${message.role == 'user' ? wrapUrlsToTags(message.content) : message.content}\n`;
    }, '')
    logger.info("\n透传内容：\n" + content);
  }
  else {
    // 注入消息提升注意力
    let latestMessage = messages[messages.length - 1];
    let hasFileOrImage = Array.isArray(latestMessage.content)
      && latestMessage.content.some(v => (typeof v === 'object' && ['file', 'image_url'].includes(v['type'])));
    // 第二轮开始注入system prompt
    if (hasFileOrImage) {
      let newFileMessage = {
        "content": "关注用户最新发送文件和消息",
        "role": "system"
      };
      messages.splice(messages.length - 1, 0, newFileMessage);
      logger.info("注入提升尾部文件注意力system prompt");
    } else {
      let newTextMessage = {
        "content": "关注用户最新的消息",
        "role": "system"
      };
      messages.splice(messages.length - 1, 0, newTextMessage);
      logger.info("注入提升尾部消息注意力system prompt");
    }
    content = messages.reduce((content, message) => {
      if (_.isArray(message.content)) {
        return message.content.reduce((_content, v) => {
          if (!_.isObject(v) || v['type'] != 'text') return _content;
          return _content + `${message.role || "user"}:${v["text"] || ""}\n`;
        }, content);
      }
      return content += `${message.role || "user"}:${message.role == 'user' ? wrapUrlsToTags(message.content) : message.content}\n`;
    }, '')
    logger.info("\n对话合并：\n" + content);
  }

  return [
    { role: 'user', content }
  ]
}

/**
 * 将消息中的URL包装为HTML标签
 * 
 * kimi网页版中会自动将url包装为url标签用于处理状态，此处也得模仿处理，否则无法成功解析
 * 
 * @param content 消息内容
 */
function wrapUrlsToTags(content: string) {
  return content.replace(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/gi, url => `<url id="" type="url" status="" title="" wc="">${url}</url>`);
}

/**
 * 获取预签名的文件URL
 * 
 * @param filename 文件名称
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function preSignUrl(filename: string, refreshToken: string) {
  const {
    accessToken,
    userId
  } = await acquireToken(refreshToken);
  const result = await axios.post('https://kimi.moonshot.cn/api/pre-sign-url', {
    action: 'file',
    name: filename
  }, {
    timeout: 15000,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Referer: `https://kimi.moonshot.cn/`,
      'X-Traffic-Id': userId,
      ...FAKE_HEADERS
    },
    validateStatus: () => true
  });
  return checkResult(result, refreshToken);
}

/**
 * 预检查文件URL有效性
 * 
 * @param fileUrl 文件URL
 */
async function checkFileUrl(fileUrl: string) {
  if (util.isBASE64Data(fileUrl))
    return;
  const result = await axios.head(fileUrl, {
    timeout: 15000,
    validateStatus: () => true
  });
  if (result.status >= 400)
    throw new APIException(EX.API_FILE_URL_INVALID, `File ${fileUrl} is not valid: [${result.status}] ${result.statusText}`);
  // 检查文件大小
  if (result.headers && result.headers['content-length']) {
    const fileSize = parseInt(result.headers['content-length'], 10);
    if (fileSize > FILE_MAX_SIZE)
      throw new APIException(EX.API_FILE_EXECEEDS_SIZE, `File ${fileUrl} is not valid`);
  }
}

/**
 * 上传文件
 * 
 * @param fileUrl 文件URL
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function uploadFile(fileUrl: string, refreshToken: string) {
  // 预检查远程文件URL可用性
  await checkFileUrl(fileUrl);

  let filename, fileData, mimeType;
  // 如果是BASE64数据则直接转换为Buffer
  if (util.isBASE64Data(fileUrl)) {
    mimeType = util.extractBASE64DataFormat(fileUrl);
    const ext = mime.getExtension(mimeType);
    filename = `${util.uuid()}.${ext}`;
    fileData = Buffer.from(util.removeBASE64DataHeader(fileUrl), 'base64');
  }
  // 下载文件到内存，如果您的服务器内存很小，建议考虑改造为流直传到下一个接口上，避免停留占用内存
  else {
    filename = path.basename(fileUrl);
    ({ data: fileData } = await axios.get(fileUrl, {
      responseType: 'arraybuffer',
      // 100M限制
      maxContentLength: FILE_MAX_SIZE,
      // 60秒超时
      timeout: 60000
    }));
  }

  // 获取预签名文件URL
  const {
    url: uploadUrl,
    object_name: objectName
  } = await preSignUrl(filename, refreshToken);

  // 获取文件的MIME类型
  mimeType = mimeType || mime.getType(filename);
  // 上传文件到目标OSS
  const {
    accessToken,
    userId
  } = await acquireToken(refreshToken);
  let result = await axios.request({
    method: 'PUT',
    url: uploadUrl,
    data: fileData,
    // 100M限制
    maxBodyLength: FILE_MAX_SIZE,
    // 120秒超时
    timeout: 120000,
    headers: {
      'Content-Type': mimeType,
      Authorization: `Bearer ${accessToken}`,
      Referer: `https://kimi.moonshot.cn/`,
      'X-Traffic-Id': userId,
      ...FAKE_HEADERS
    },
    validateStatus: () => true
  });
  checkResult(result, refreshToken);

  let fileId, status, startTime = Date.now();
  while (status != 'initialized') {
    if (Date.now() - startTime > 30000)
      throw new Error('文件等待处理超时');
    // 获取文件上传结果
    result = await axios.post('https://kimi.moonshot.cn/api/file', {
      type: 'file',
      name: filename,
      object_name: objectName,
      timeout: 15000
    }, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Referer: `https://kimi.moonshot.cn/`,
        'X-Traffic-Id': userId,
        ...FAKE_HEADERS
      }
    });
    ({ id: fileId, status } = checkResult(result, refreshToken));
  }

  startTime = Date.now();
  let parseFinish = false;
  while (!parseFinish) {
    if (Date.now() - startTime > 30000)
      throw new Error('文件等待处理超时');
    // 处理文件转换
    parseFinish = await new Promise(resolve => {
      axios.post('https://kimi.moonshot.cn/api/file/parse_process', {
        ids: [fileId],
        timeout: 120000
      }, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Referer: `https://kimi.moonshot.cn/`,
          'X-Traffic-Id': userId,
          ...FAKE_HEADERS
        }
      })
        .then(() => resolve(true))
        .catch(() => resolve(false));
    });
  }

  return fileId;
}

/**
 * 检查请求结果
 * 
 * @param result 结果
 * @param refreshToken 用于刷新access_token的refresh_token
 */
function checkResult(result: AxiosResponse, refreshToken: string) {
  if (result.status == 401) {
    accessTokenMap.delete(refreshToken);
    throw new APIException(EX.API_REQUEST_FAILED);
  }
  if (!result.data)
    return null;
  const { error_type, message } = result.data;
  if (!_.isString(error_type))
    return result.data;
  if (error_type == 'auth.token.invalid')
    accessTokenMap.delete(refreshToken);
  if (error_type == 'chat.user_stream_pushing')
    throw new APIException(EX.API_CHAT_STREAM_PUSHING);
  throw new APIException(EX.API_REQUEST_FAILED, `[请求kimi失败]: ${message}`);
}

/**
 * 从流接收完整的消息内容
 * 
 * @param model 模型名称
 * @param convId 会话ID
 * @param stream 消息流
 */
async function receiveStream(model: string, convId: string, stream: any) {
  return new Promise((resolve, reject) => {
    // 消息初始化
    const data = {
      id: convId,
      model,
      object: 'chat.completion',
      choices: [
        { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: util.unixTimestamp()
    };
    let refContent = '';
    const silentSearch = model.indexOf('silent_search') != -1;
    const parser = createParser(event => {
      try {
        if (event.type !== "event") return;
        // 解析JSON
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result))
          throw new Error(`Stream response invalid: ${event.data}`);
        // 处理消息
        if (result.event == 'cmpl' && result.text) {
          const exceptCharIndex = result.text.indexOf("�");
          data.choices[0].message.content += result.text.substring(0, exceptCharIndex == -1 ? result.text.length : exceptCharIndex);
        }
        // 处理结束或错误
        else if (result.event == 'all_done' || result.event == 'error') {
          data.choices[0].message.content += (result.event == 'error' ? '\n[内容由于不合规被停止生成，我们换个话题吧]' : '') + (refContent ? `\n\n搜索结果来自：\n${refContent}` : '');
          refContent = '';
          resolve(data);
        }
        // 处理联网搜索
        else if (!silentSearch && result.event == 'search_plus' && result.msg && result.msg.type == 'get_res')
          refContent += `${result.msg.title} - ${result.msg.url}\n`;
        // else
        //   logger.warn(result.event, result);
      }
      catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    // 将流数据喂给SSE转换器
    stream.on("data", buffer => parser.feed(buffer.toString()));
    stream.once("error", err => reject(err));
    stream.once("close", () => resolve(data));
  });
}

/**
 * 创建转换流
 * 
 * 将流格式转换为gpt兼容流格式
 * 
 * @param model 模型名称
 * @param convId 会话ID
 * @param stream 消息流
 * @param endCallback 传输结束回调
 */
function createTransStream(model: string, convId: string, stream: any, endCallback?: Function) {
  // 消息创建时间
  const created = util.unixTimestamp();
  // 创建转换流
  const transStream = new PassThrough();
  let searchFlag = false;
  const silentSearch = model.indexOf('silent_search') != -1;
  !transStream.closed && transStream.write(`data: ${JSON.stringify({
    id: convId,
    model,
    object: 'chat.completion.chunk',
    choices: [
      { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }
    ],
    created
  })}\n\n`);
  const parser = createParser(event => {
    try {
      if (event.type !== "event") return;
      // 解析JSON
      const result = _.attempt(() => JSON.parse(event.data));
      if (_.isError(result))
        throw new Error(`Stream response invalid: ${event.data}`);
      // 处理消息
      if (result.event == 'cmpl') {
        const exceptCharIndex = result.text.indexOf("�");
        const chunk = result.text.substring(0, exceptCharIndex == -1 ? result.text.length : exceptCharIndex);
        const data = `data: ${JSON.stringify({
          id: convId,
          model,
          object: 'chat.completion.chunk',
          choices: [
            { index: 0, delta: { content: (searchFlag ? '\n' : '') + chunk }, finish_reason: null }
          ],
          created
        })}\n\n`;
        if (searchFlag)
          searchFlag = false;
        !transStream.closed && transStream.write(data);
      }
      // 处理结束或错误
      else if (result.event == 'all_done' || result.event == 'error') {
        const data = `data: ${JSON.stringify({
          id: convId,
          model,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0, delta: result.event == 'error' ? {
                content: '\n[内容由于不合规被停止生成，我们换个话题吧]'
              } : {}, finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created
        })}\n\n`;
        !transStream.closed && transStream.write(data);
        !transStream.closed && transStream.end('data: [DONE]\n\n');
        endCallback && endCallback();
      }
      // 处理联网搜索
      else if (!silentSearch && result.event == 'search_plus' && result.msg && result.msg.type == 'get_res') {
        if (!searchFlag)
          searchFlag = true;
        const data = `data: ${JSON.stringify({
          id: convId,
          model,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0, delta: {
                content: `检索 ${result.msg.title} - ${result.msg.url} ...\n`
              }, finish_reason: null
            }
          ],
          created
        })}\n\n`;
        !transStream.closed && transStream.write(data);
      }
      // else
      //   logger.warn(result.event, result);
    }
    catch (err) {
      logger.error(err);
      !transStream.closed && transStream.end('\n\n');
    }
  });
  // 将流数据喂给SSE转换器
  stream.on("data", buffer => parser.feed(buffer.toString()));
  stream.once("error", () => !transStream.closed && transStream.end('data: [DONE]\n\n'));
  stream.once("close", () => !transStream.closed && transStream.end('data: [DONE]\n\n'));
  return transStream;
}

/**
 * Token切分
 * 
 * @param authorization 认证字符串
 */
function tokenSplit(authorization: string) {
  return authorization.replace('Bearer ', '').split(',');
}

/**
 * 获取Token存活状态
 */
async function getTokenLiveStatus(refreshToken: string) {
  const result = await axios.get('https://kimi.moonshot.cn/api/auth/token/refresh', {
    headers: {
      Authorization: `Bearer ${refreshToken}`,
      Referer: 'https://kimi.moonshot.cn/',
      ...FAKE_HEADERS
    },
    timeout: 15000,
    validateStatus: () => true
  });
  try {
    const {
      access_token,
      refresh_token
    } = checkResult(result, refreshToken);
    return !!(access_token && refresh_token)
  }
  catch (err) {
    return false;
  }
}

export default {
  createConversation,
  createCompletion,
  createCompletionStream,
  getTokenLiveStatus,
  tokenSplit
};
