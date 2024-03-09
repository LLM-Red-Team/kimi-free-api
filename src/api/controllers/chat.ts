import { PassThrough } from "stream";
import _ from 'lodash';
import axios, { AxiosResponse } from 'axios';

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from 'eventsource-parser'
import logger from '@/lib/logger.ts';
import util from '@/lib/util.ts';

const ACCESS_TOKEN_EXPIRES = 300;
const FAKE_HEADERS = {
  'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
};
const accessTokenMap = new Map();

async function requestToken(refreshToken: string) {
  const result = await axios.get('https://kimi.moonshot.cn/api/auth/token/refresh', {
    headers: {
      Authorization: `Bearer ${refreshToken}`,
      Referer: 'https://kimi.moonshot.cn',
      ...FAKE_HEADERS
    },
    validateStatus: () => true
  });
  const {
    access_token,
    refresh_token
  } = checkResult(result, refreshToken);
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    refreshTime: util.unixTimestamp() + ACCESS_TOKEN_EXPIRES
  }
}

async function acquireToken(refreshToken: string): Promise<string> {
  let result = accessTokenMap.get(refreshToken);
  if (!result) {
    result = await requestToken(refreshToken);
    accessTokenMap.set(refreshToken, result);
  }
  if (util.unixTimestamp() > result.refreshTime)
    result = await requestToken(refreshToken);
  return result.accessToken;
}

async function createConversation(name: string, refreshToken: string) {
  const token = await acquireToken(refreshToken);
  const result = await axios.post('https://kimi.moonshot.cn/api/chat', {
    name,
    is_example: false
  }, {
    headers: {
      Authorization: `Bearer ${token}`,
      Referer: 'https://kimi.moonshot.cn',
      ...FAKE_HEADERS
    },
    validateStatus: () => true
  });
  const {
    id: convId
  } = checkResult(result, refreshToken);
  return convId;
}

async function removeConversation(convId: string, refreshToken: string) {
  const token = await acquireToken(refreshToken);
  const result = await axios.delete(`https://kimi.moonshot.cn/api/chat/${convId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Referer: `https://kimi.moonshot.cn/chat/${convId}`,
      ...FAKE_HEADERS
    },
    validateStatus: () => true
  });
  checkResult(result, refreshToken);
}

async function createCompletion(messages: any[], refreshToken: string, useSearch = true) {
  logger.info(messages);
  const convId = await createConversation(`cmpl-${util.uuid(false)}`, refreshToken);
  const token = await acquireToken(refreshToken);
  const result = await axios.post(`https://kimi.moonshot.cn/api/chat/${convId}/completion/stream`, {
    messages,
    use_search: useSearch
  }, {
    headers: {
      Authorization: `Bearer ${token}`,
      Referer: `https://kimi.moonshot.cn/chat/${convId}`,
      ...FAKE_HEADERS
    },
    validateStatus: () => true,
    responseType: 'stream'
  });
  const answer = await receiveStream(convId, result.data);
  removeConversation(convId, refreshToken)
      .catch(err => console.error(err));
  return answer;
}

async function createCompletionStream(messages: any[], refreshToken: string, useSearch = true) {
  logger.info(messages);
  const convId = await createConversation(`cmpl-${util.uuid(false)}`, refreshToken);
  const token = await acquireToken(refreshToken);
  const result = await axios.post(`https://kimi.moonshot.cn/api/chat/${convId}/completion/stream`, {
    messages,
    use_search: useSearch
  }, {
    headers: {
      Authorization: `Bearer ${token}`,
      Referer: `https://kimi.moonshot.cn/chat/${convId}`,
      ...FAKE_HEADERS
    },
    validateStatus: () => true,
    responseType: 'stream'
  });
  return createTransStream(convId, result.data, () => {
    removeConversation(convId, refreshToken)
      .catch(err => console.error(err));
  });
}

function checkResult(result: AxiosResponse, refreshToken: string) {
  if(result.status == 401) {
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
  throw new APIException(EX.API_REQUEST_FAILED, `[请求kimi失败]: ${message}`);
}

async function receiveStream(convId: string, stream: any) {
  return new Promise((resolve, reject) => {
    const data = {
      id: convId,
      model: 'kimi',
      object: 'chat.completion',
      choices: [
        { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }
      ],
      created: parseInt(performance.now() as any)
    };
    let refContent = '';
    const parser = createParser(event => {
      try {
        if (event.type !== "event") return;
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result))
          throw new Error(`stream response invalid: ${event.data}`);
        if (result.event == 'cmpl') {
          data.choices[0].message.content += result.text;
        }
        else if (result.event == 'all_done' || result.event == 'error') {
          data.choices[0].message.content += (result.event == 'error' ? '\n[内容由于不合规被停止生成，我们换个话题吧]' : '') + (refContent ? `\n\n搜索结果来自：\n${refContent}` : '');
          refContent = '';
          resolve(data);
        }
        else if(result.event == 'search_plus' && result.msg && result.msg.type == 'get_res')
          refContent += `${result.msg.title}(${result.msg.url})\n`;
        // else
        //   logger.warn(result.event, result);
      }
      catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    stream.on("data", buffer => parser.feed(buffer.toString()));
    stream.once("error", err => reject(err));
    stream.once("close", () => resolve(data));
  });
}

function createTransStream(convId: string, stream: any, endCallback?: Function) {
  const created = parseInt(performance.now() as any);
  const transStream = new PassThrough();
  let searchFlag = false;
  !transStream.closed && transStream.write(`data: ${JSON.stringify({
    id: convId,
    model: 'kimi',
    object: 'chat.completion.chunk',
    choices: [
      { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }
    ],
    created
  })}\n\n`);
  const parser = createParser(event => {
    try {
      if (event.type !== "event") return;
      const result = _.attempt(() => JSON.parse(event.data));
      if (_.isError(result))
        throw new Error(`stream response invalid: ${event.data}`);
      if (result.event == 'cmpl') {
        const data = `data: ${JSON.stringify({
          id: convId,
          model: 'kimi',
          object: 'chat.completion.chunk',
          choices: [
            { index: 0, delta: { content: (searchFlag ? '\n' : '') + result.text }, finish_reason: null }
          ],
          created
        })}\n\n`;
        if(searchFlag)
          searchFlag = false;
        !transStream.closed && transStream.write(data);
      }
      else if (result.event == 'all_done' || result.event == 'error') {
        const data = `data: ${JSON.stringify({
          id: convId,
          model: 'kimi',
          object: 'chat.completion.chunk',
          choices: [
            { index: 0, delta: result.event == 'error' ? {
              content: '\n[内容由于不合规被停止生成，我们换个话题吧]'
            } : {}, finish_reason: 'stop' }
          ],
          created
        })}\n\n`;
        !transStream.closed && transStream.write(data);
        !transStream.closed && transStream.end('data: [DONE]\n\n');
        endCallback && endCallback();
      }
      else if(result.event == 'search_plus' && result.msg && result.msg.type == 'get_res') {
        if(!searchFlag)
          searchFlag = true;
        const data = `data: ${JSON.stringify({
          id: convId,
          model: 'kimi',
          object: 'chat.completion.chunk',
          choices: [
            { index: 0, delta: {
              content: `检索 ${result.msg.title}(${result.msg.url}) ...\n`
            }, finish_reason: null }
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
  stream.on("data", buffer => parser.feed(buffer.toString()));
  stream.once("error", () => !transStream.closed && transStream.end('data: [DONE]\n\n'));
  stream.once("close", () => !transStream.closed && transStream.end('data: [DONE]\n\n'));
  return transStream;
}

export default {
  createConversation,
  createCompletion,
  createCompletionStream
};
