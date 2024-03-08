import path from 'path';

import fs from 'fs-extra';
import minimist from 'minimist';
import _ from 'lodash';

const cmdArgs = minimist(process.argv.slice(2));  //获取命令行参数
const envVars = process.env;  //获取环境变量

class Environment {

    /** 命令行参数 */
    cmdArgs: any;
    /** 环境变量 */
    envVars: any;
    /** 环境名称 */
    env?: string;
    /** 服务名称 */
    name?: string;
    /** 服务地址 */
    host?: string;
    /** 服务端口 */
    port?: number;
    /** 包参数 */
    package: any;

    constructor(options: any = {}) {
        const { cmdArgs, envVars, package: _package } = options;
        this.cmdArgs = cmdArgs;
        this.envVars = envVars;
        this.env = _.defaultTo(cmdArgs.env || envVars.SERVER_ENV, 'dev');
        this.name = cmdArgs.name || envVars.SERVER_NAME || undefined;
        this.host = cmdArgs.host || envVars.SERVER_HOST || undefined;
        this.port = Number(cmdArgs.port || envVars.SERVER_PORT) ? Number(cmdArgs.port || envVars.SERVER_PORT) : undefined;
        this.package = _package;
    }

}

export default new Environment({
    cmdArgs,
    envVars,
    package: JSON.parse(fs.readFileSync(path.join(path.resolve(), "package.json")).toString())
});