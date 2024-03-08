import  _ from 'lodash';

export interface BodyOptions {
    code?: number;
    message?: string;
    data?: any;
    statusCode?: number;
}

export default class Body {

    /** 状态码 */
    code: number;
    /** 状态消息 */
    message: string;
    /** 载荷 */
    data: any;
    /** HTTP状态码 */
    statusCode: number;

    constructor(options: BodyOptions = {}) {
        const { code, message, data, statusCode } = options;
        this.code = Number(_.defaultTo(code, 0));
        this.message = _.defaultTo(message, 'OK');
        this.data = _.defaultTo(data, null);
        this.statusCode = Number(_.defaultTo(statusCode, 200));
    }

    toObject() {
        return {
            code: this.code,
            message: this.message,
            data: this.data
        };
    }

    static isInstance(value) {
        return value instanceof Body;
    }

}