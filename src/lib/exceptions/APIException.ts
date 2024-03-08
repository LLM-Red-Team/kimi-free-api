import Exception from './Exception.js';

export default class APIException extends Exception {

    /**
     * 构造异常
     * 
     * @param {[number, string]} exception 异常
     */
    constructor(exception: (string | number)[], errmsg?: string) {
        super(exception, errmsg);
    }

}