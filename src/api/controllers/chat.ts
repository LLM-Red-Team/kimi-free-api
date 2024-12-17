import { PassThrough } from "stream";
import path from 'path';
import _ from 'lodash';
import mime from 'mime';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

import type IStreamMessage from "../interfaces/IStreamMessage.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from 'eventsource-parser'
import logger from '@/lib/logger.ts';
import util from '@/lib/util.ts';

// 模型名称
const MODEL_NAME = 'kimi';
// 设备ID
const DEVICE_ID = Math.random() * 999999999999999999 + 7000000000000000000;
// SessionID
const SESSION_ID = Math.random() * 99999999999999999 + 1700000000000000000;
// access_token有效期
const ACCESS_TOKEN_EXPIRES = 300;
// 最大重试次数
const MAX_RETRY_COUNT = 3;
// 重试延迟
const RETRY_DELAY = 5000;
// 基础URL
const BASE_URL = 'https://kimi.moonshot.cn';
// 伪装headers
const FAKE_HEADERS = {
  'Accept': '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Origin': BASE_URL,
  'Cookie': util.generateCookie(),
  'R-Timezone': 'Asia/Shanghai',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Priority': 'u=1, i',
  'X-Msh-Device-Id': `${DEVICE_ID}`,
  'X-Msh-Platform': 'web',
  'X-Msh-Session-Id': `${SESSION_ID}`
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
    const result = await axios.get(`${BASE_URL}/api/auth/token/refresh`, {
      headers: {
        Authorization: `Bearer ${refreshToken}`,
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true
    });
    const {
      access_token,
      refresh_token
    } = checkResult(result, refreshToken);
    const userResult = await axios.get(`${BASE_URL}/api/user`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true
    });
    if(!userResult.data.id)
      throw new APIException(EX.API_REQUEST_FAILED, '获取用户信息失败');
    return {
      userId: userResult.data.id,
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
      logger.error(err);
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
 * 发送请求
 */
export async function request(
  method: string,
  uri: string,
  refreshToken: string,
  options: AxiosRequestConfig = {}
) {
  const {
    accessToken,
    userId
  } = await acquireToken(refreshToken);
  logger.info(`url: ${uri}`);
  const result = await axios({
    method,
    url: `${BASE_URL}${uri}`,
    params: options.params,
    data: options.data,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Traffic-Id': userId,
      ...FAKE_HEADERS,
      ...(options.headers || {})
    },
    timeout: options.timeout || 15000,
    responseType: options.responseType,
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
async function createConversation(model: string, name: string, refreshToken: string) {
  const {
    id: convId
  } = await request('POST', '/api/chat', refreshToken, {
    data: {
      enter_method: 'new_chat',
      is_example: false,
      kimiplus_id: /^[0-9a-z]{20}$/.test(model) ? model : 'kimi',
      name
    }
  });
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
  return await request('DELETE', `/api/chat/${convId}`, refreshToken);
}

/**
 * 获取建议
 * 
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function getSuggestion(query: string, refreshToken: string) {
  return await request('POST', '/api/suggestion', refreshToken, {
    data: {
      offset: 0,
      page_referer: 'chat',
      query: query.replace('user:', '').replace('assistant:', ''),
      scene: 'first_round',
      size: 10
    }
  });
}

/**
 * 预处理N2S
 * 
 * 预处理N2S，用于获取搜索结果
 * 
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refs 引用文件ID列表
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param refConvId 引用会话ID
 */
async function preN2s(model: string, messages: { role: string, content: string }[], refs: string[], refreshToken: string, refConvId?: string) {
  const isSearchModel = model.indexOf('search') != -1;
  return await request('POST', `/api/chat/${refConvId}/pre-n2s`, refreshToken, {
    data: {
      is_pro_search: false,
      kimiplus_id: /^[0-9a-z]{20}$/.test(model) ? model : 'kimi',
      messages,
      refs,
      use_search: isSearchModel
    }
  });
}

/**
 * token计数
 * 
 * @param query 查询内容
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param refConvId 引用会话ID
 */
async function tokenSize(query: string, refs: string[], refreshToken: string, refConvId: string) {
  return await request('POST', `/api/chat/${refConvId}/token_size`, refreshToken, {
    data: {
      content: query,
      refs: []
    }
  });
}

/**
 * 获取探索版使用量
 * 
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function getResearchUsage(refreshToken: string): Promise<{
  remain,
  total,
  used
}> {
  return await request('GET', '/api/chat/research/usage', refreshToken);
}

/**
 * 同步对话补全
 * 
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param refConvId 引用会话ID
 * @param retryCount 重试次数
 */
async function createCompletion(model = MODEL_NAME, messages: any[], refreshToken: string, refConvId?: string, retryCount = 0, segmentId?: string): Promise<IStreamMessage> {
  return (async () => {
    logger.info(messages);

    // 创建会话
    const convId = /[0-9a-zA-Z]{20}/.test(refConvId) ? refConvId : await createConversation(model, "未命名会话", refreshToken);

    // 提取引用文件URL并上传kimi获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refResults = refFileUrls.length ? await Promise.all(refFileUrls.map(fileUrl => uploadFile(fileUrl, refreshToken, convId))) : [];
    const refs = refResults.map(result => result.id);
    const refsFile = refResults.map(result => ({
      detail: result,
      done: true,
      file: {},
      file_info: result,
      id: result.id,
      name: result.name,
      parse_status: 'success',
      size: result.size,
      upload_progress: 100,
      upload_status: 'success'
    }));

    // 伪装调用获取用户信息
    fakeRequest(refreshToken)
      .catch(err => logger.error(err));

    // 消息预处理
    const sendMessages = messagesPrepare(messages, !!refConvId);

    !segmentId && preN2s(model, sendMessages, refs, refreshToken, convId)
      .catch(err => logger.error(err));
    getSuggestion(sendMessages[0].content, refreshToken)
      .catch(err => logger.error(err));
    tokenSize(sendMessages[0].content, refs, refreshToken, convId)
      .catch(err => logger.error(err));
    
    const isMath = model.indexOf('math') != -1;
    const isSearchModel = model.indexOf('search') != -1;
    const isResearchModel = model.indexOf('research') != -1;
    const isK1Model = model.indexOf('k1') != -1;

    logger.info(`使用模型: ${model}，是否联网检索: ${isSearchModel}，是否探索版: ${isResearchModel}，是否K1模型: ${isK1Model}，是否数学模型: ${isMath}`);

    if(segmentId)
      logger.info(`继续请求，segmentId: ${segmentId}`);

    // 检查探索版使用量
    if(isResearchModel) {
      const {
        total,
        used
      } = await getResearchUsage(refreshToken);
      if(used >= total)
        throw new APIException(EX.API_RESEARCH_EXCEEDS_LIMIT, `探索版使用量已达到上限`);
      logger.info(`探索版当前额度: ${used}/${total}`);
    }

    const kimiplusId = isK1Model ? 'crm40ee9e5jvhsn7ptcg' : (/^[0-9a-z]{20}$/.test(model) ? model : 'kimi');
    
    // 请求补全流
    const stream = await request('POST', `/api/chat/${convId}/completion/stream`, refreshToken, {
      data: segmentId ? {
        segment_id: segmentId,
        action: 'continue',
        messages: [{ role: 'user', content: ' ' }],
        kimiplus_id: kimiplusId,
        extend: { sidebar: true }
      } : {
        kimiplus_id: kimiplusId,
        messages: sendMessages,
        refs,
        refs_file: refsFile,
        use_math: isMath,
        use_research: isResearchModel,
        use_search: isSearchModel,
        extend: { sidebar: true }
      },
      headers: {
        Referer: `https://kimi.moonshot.cn/chat/${convId}`
      },
      responseType: 'stream'
    });

    const streamStartTime = util.timestamp();

    // 接收流为输出文本
    const answer = await receiveStream(model, convId, stream);

    // 如果上次请求生成长度超限，则继续请求
    if(answer.choices[0].finish_reason == 'length' && answer.segment_id) {
      const continueAnswer = await createCompletion(model, [], refreshToken, convId, retryCount, answer.segment_id);
      answer.choices[0].message.content += continueAnswer.choices[0].message.content;
    }
  
    logger.success(`Stream has completed transfer ${util.timestamp() - streamStartTime}ms`);

    // 异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
    // 如果引用会话将不会清除，因为我们不知道什么时候你会结束会话
    !refConvId && removeConversation(convId, refreshToken)
      .catch(err => console.error(err));

    return answer;
  })()
    .catch(err => {
      if (retryCount < MAX_RETRY_COUNT) {
        logger.error(`Stream response error: ${err.message}`);
        logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
        return (async () => {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          return createCompletion(model, messages, refreshToken, refConvId, retryCount + 1);
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
 * @param refConvId 引用会话ID
 * @param retryCount 重试次数
 */
async function createCompletionStream(model = MODEL_NAME, messages: any[], refreshToken: string, refConvId?: string, retryCount = 0) {
  return (async () => {
    logger.info(messages);

    // 创建会话
    const convId = /[0-9a-zA-Z]{20}/.test(refConvId) ? refConvId : await createConversation(model, "未命名会话", refreshToken);

    // 提取引用文件URL并上传kimi获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refResults = refFileUrls.length ? await Promise.all(refFileUrls.map(fileUrl => uploadFile(fileUrl, refreshToken, convId))) : [];
    const refs = refResults.map(result => result.id);
    const refsFile = refResults.map(result => ({
      detail: result,
      done: true,
      file: {},
      file_info: result,
      id: result.id,
      name: result.name,
      parse_status: 'success',
      size: result.size,
      upload_progress: 100,
      upload_status: 'success'
    }));

    // 伪装调用获取用户信息
    fakeRequest(refreshToken)
      .catch(err => logger.error(err));

    const sendMessages = messagesPrepare(messages, !!refConvId);

    preN2s(model, sendMessages, refs, refreshToken, convId)
      .catch(err => logger.error(err));
    getSuggestion(sendMessages[0].content, refreshToken)
      .catch(err => logger.error(err));
    tokenSize(sendMessages[0].content, refs, refreshToken, convId)
      .catch(err => logger.error(err));
    
    const isMath = model.indexOf('math') != -1;
    const isSearchModel = model.indexOf('search') != -1;
    const isResearchModel = model.indexOf('research') != -1;
    const isK1Model = model.indexOf('k1') != -1;

    logger.info(`使用模型: ${model}，是否联网检索: ${isSearchModel}，是否探索版: ${isResearchModel}，是否K1模型: ${isK1Model}，是否数学模型: ${isMath}`);

    // 检查探索版使用量
    if(isResearchModel) {
      const {
        total,
        used
      } = await getResearchUsage(refreshToken);
      if(used >= total)
        throw new APIException(EX.API_RESEARCH_EXCEEDS_LIMIT, `探索版使用量已达到上限`);
      logger.info(`探索版当前额度: ${used}/${total}`);
    }

    const kimiplusId = isK1Model ? 'crm40ee9e5jvhsn7ptcg' : (/^[0-9a-z]{20}$/.test(model) ? model : 'kimi');

    // 请求补全流
    const stream = await request('POST', `/api/chat/${convId}/completion/stream`, refreshToken, {
      data: {
        kimiplus_id: kimiplusId,
        messages: sendMessages,
        refs,
        refs_file: refsFile,
        use_math: isMath,
        use_research: isResearchModel,
        use_search: isSearchModel,
        extend: { sidebar: true }
      },
      headers: {
        Referer: `https://kimi.moonshot.cn/chat/${convId}`
      },
      responseType: 'stream'
    });

    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    return createTransStream(model, convId, stream, () => {
      logger.success(`Stream has completed transfer ${util.timestamp() - streamStartTime}ms`);
      // 流传输结束后异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
      // 如果引用会话将不会清除，因为我们不知道什么时候你会结束会话
      !refConvId && removeConversation(convId, refreshToken)
        .catch(err => console.error(err));
    });
  })()
    .catch(err => {
      if (retryCount < MAX_RETRY_COUNT) {
        logger.error(`Stream response error: ${err.message}`);
        logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
        return (async () => {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          return createCompletionStream(model, messages, refreshToken, refConvId, retryCount + 1);
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
  await [
    () => request('GET', '/api/user', refreshToken),
    () => request('POST', '/api/user/usage', refreshToken, {
      data: {
        usage: ['kimiv', 'math']
      }
    }),
    () => request('GET', '/api/chat_1m/user/status', refreshToken),
    () => request('GET', '/api/kimi_mv/user/status', refreshToken),
    () => request('POST', '/api/kimiplus/history', refreshToken),
    () => request('POST', '/api/kimiplus/search', refreshToken, {
      data: {
        offset: 0,
        size: 20
      }
    }),
    () => request('POST', '/api/chat/list', refreshToken, {
      data: {
        offset: 0,
        size: 50
      }
    }),
  ][Math.floor(Math.random() * 7)]();
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
async function preSignUrl(action: string, filename: string, refreshToken: string) {
  const {
    accessToken,
    userId
  } = await acquireToken(refreshToken);
  const result = await axios.post('https://kimi.moonshot.cn/api/pre-sign-url', {
    action,
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
 * @param refConvId 引用会话ID
 */
async function uploadFile(fileUrl: string, refreshToken: string, refConvId?: string) {
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

  const fileType = (mimeType || '').includes('image') ? 'image' : 'file';

  // 获取预签名文件URL
  let {
    url: uploadUrl,
    object_name: objectName,
    file_id: fileId
  } = await preSignUrl(fileType, filename, refreshToken);

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

  let status, startTime = Date.now();
  let fileDetail;
  while (status != 'initialized' && status != 'parsed') {
    if (Date.now() - startTime > 30000)
      throw new Error('文件等待处理超时');
    // 获取文件上传结果
    result = await axios.post('https://kimi.moonshot.cn/api/file', fileType == 'image' ? {
      type: 'image',
      file_id: fileId,
      name: filename
    } : {
      type: 'file',
      name: filename,
      object_name: objectName,
      file_id: '',
      chat_id: refConvId
    }, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Referer: `https://kimi.moonshot.cn/`,
        'X-Traffic-Id': userId,
        ...FAKE_HEADERS
      }
    });
    fileDetail = checkResult(result, refreshToken);
    ({ id: fileId, status } = fileDetail);
  }

  startTime = Date.now();
  let parseFinish = status == 'parsed';
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

  return fileDetail;
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
async function receiveStream(model: string, convId: string, stream: any): Promise<IStreamMessage> {
  let webSearchCount = 0;
  let temp = Buffer.from('');
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
      segment_id: '',
      created: util.unixTimestamp()
    };
    let refContent = '';
    const silentSearch = model.indexOf('silent') != -1;
    const parser = createParser(event => {
      try {
        if (event.type !== "event") return;
        // 解析JSON
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result))
          throw new Error(`Stream response invalid: ${event.data}`);
        // 处理消息
        if (result.event == 'cmpl' && result.text) {
          data.choices[0].message.content += result.text;
        }
        // 处理请求ID
        else if(result.event == 'req') {
          data.segment_id = result.id;
        }
        // 处理超长文本
        else if(result.event == 'length') {
          logger.warn('此次生成达到max_tokens，稍候将继续请求拼接完整响应');
          data.choices[0].finish_reason = 'length';
        }
        // 处理结束或错误
        else if (result.event == 'all_done' || result.event == 'error') {
          data.choices[0].message.content += (result.event == 'error' ? '\n[内容由于不合规被停止生成，我们换个话题吧]' : '') + (refContent ? `\n\n搜索结果来自：\n${refContent}` : '');
          refContent = '';
          resolve(data);
        }
        // 处理联网搜索
        else if (!silentSearch && result.event == 'search_plus' && result.msg && result.msg.type == 'get_res') {
          webSearchCount += 1;
          refContent += `【检索 ${webSearchCount}】 [${result.msg.title}](${result.msg.url})\n\n`;
        }
        // else
        //   logger.warn(result.event, result);
      }
      catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    // 将流数据喂给SSE转换器
    stream.on("data", buffer => {
      // 检查buffer是否以完整UTF8字符结尾
      if (buffer.toString().indexOf('�') != -1) {
        // 如果不完整则累积buffer直到收到完整字符
        temp = Buffer.concat([temp, buffer]);
        return;
      }
      // 将之前累积的不完整buffer拼接
      if (temp.length > 0) {
        buffer = Buffer.concat([temp, buffer]);
        temp = Buffer.from('');
      }
      parser.feed(buffer.toString());
    });
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
  let webSearchCount = 0;
  let searchFlag = false;
  let lengthExceed = false;
  let segmentId = '';
  const silentSearch = model.indexOf('silent') != -1;
  !transStream.closed && transStream.write(`data: ${JSON.stringify({
    id: convId,
    model,
    object: 'chat.completion.chunk',
    choices: [
      { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }
    ],
    segment_id: '',
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
          segment_id: segmentId,
          created
        })}\n\n`;
        if (searchFlag)
          searchFlag = false;
        !transStream.closed && transStream.write(data);
      }
      // 处理请求ID
      else if(result.event == 'req') {
        segmentId = result.id;
      }
      // 处理超长文本
      else if (result.event == 'length') {
        lengthExceed = true;
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
              } : {}, finish_reason: lengthExceed ? 'length' : 'stop'
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          segment_id: segmentId,
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
        webSearchCount += 1;
        const data = `data: ${JSON.stringify({
          id: convId,
          model,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0, delta: {
                content: `【检索 ${webSearchCount}】 [${result.msg.title}](${result.msg.url})\n`
              }, finish_reason: null
            }
          ],
          segment_id: segmentId,
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
