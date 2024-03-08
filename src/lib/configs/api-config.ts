import path from 'path';

import fs from 'fs-extra';
import yaml from 'yaml';
import _ from 'lodash';

import environment from '@/lib/environment.ts';

const CONFIG_PATH = path.join(path.resolve(), 'configs/', environment.env, "/api.yml");

export interface ProxyAgent {
    enable?: boolean;
    protocol?: string;
    host?: string;
    port?: number;
}

export class ChatCompletionConfig {

    /** 服务提供商 */
    provider: string;
    /** 调用地址 */
    url: string;
    /** API密钥 */
    apiKey: string;
    /** API版本号 */
    apiVersion: string;
    /** 模型名称 */
    model: string;
    /** 上下文长度 */
    contextLength: number;
    /** 单次最大token数 */
    maxToken: number;
    /** 并行请求数 */
    concurrencyLimit: number;
    /** 等待响应超时时间（毫秒） */
    waitReponseTimeout: number;
    /** 网络代理 */
    proxyAgent: ProxyAgent | null;

    constructor(options?: any) {
        const { provider, url, apiKey, apiVersion, model, contextLength, concurrencyLimit, waitReponseTimeout, proxyAgent } = options || {};
        this.provider = _.defaultTo(provider, 'zhipuai');
        this.url = _.defaultTo(url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
        this.apiKey = _.defaultTo(apiKey, '');
        this.apiVersion = _.defaultTo(apiVersion, '');
        this.model = _.defaultTo(model, 'glm-4');
        this.contextLength = _.defaultTo(contextLength, 131072);
        this.concurrencyLimit = _.defaultTo(concurrencyLimit, 100);
        this.waitReponseTimeout = _.defaultTo(waitReponseTimeout, 30000);
        this.proxyAgent = _.defaultTo(proxyAgent, null);
    }

    static create(value) {
        return ChatCompletionConfig.isInstance(value) ? value : new ChatCompletionConfig(value);
    }

    static isInstance(value) {
        return value instanceof ChatCompletionConfig;
    }

}

/**
 * API配置
 */
export class APIConfig {

    /** 聊天补全配置 */
    chatCompletion: ChatCompletionConfig;

    constructor(options?: any) {
        const { chatCompletion } = options || {};
        this.chatCompletion = ChatCompletionConfig.create(chatCompletion);
    }

    static load() {
        if(!fs.pathExistsSync(CONFIG_PATH)) return new APIConfig();
        const data = yaml.parse(fs.readFileSync(CONFIG_PATH).toString());
        return new APIConfig(data);
    }

}

export default APIConfig.load();