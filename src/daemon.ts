/**
 * 守护进程
 */

import process from 'process';
import path from 'path';
import { spawn } from 'child_process';

import fs from 'fs-extra';
import { format as dateFormat } from 'date-fns';
import 'colors';

const CRASH_RESTART_LIMIT = 600;  //进程崩溃重启次数限制
const CRASH_RESTART_DELAY = 5000;  //进程崩溃重启延迟
const LOG_PATH = path.resolve("./logs/daemon.log");  //守护进程日志路径
let crashCount = 0;  //进程崩溃次数
let currentProcess;  //当前运行进程

/**
 * 写入守护进程日志
 */
function daemonLog(value, color?: string) {
    try {
        const head = `[daemon][${dateFormat(new Date(), "yyyy-MM-dd HH:mm:ss.SSS")}] `;
        value = head + value;
        console.log(color ? value[color] : value);
        fs.ensureDirSync(path.dirname(LOG_PATH));
        fs.appendFileSync(LOG_PATH, value + "\n");
    }
    catch(err) {
        console.error("daemon log write error:", err);
    }
}

daemonLog(`daemon pid: ${process.pid}`);

function createProcess() {
    const childProcess = spawn("node", ["index.js", ...process.argv.slice(2)]);  //启动子进程
    childProcess.stdout.pipe(process.stdout, { end: false });  //将子进程输出管道到当前进程输出
    childProcess.stderr.pipe(process.stderr, { end: false });  //将子进程错误输出管道到当前进程输出
    currentProcess = childProcess;  //更新当前进程
    daemonLog(`process(${childProcess.pid}) has started`);
    childProcess.on("error", err => daemonLog(`process(${childProcess.pid}) error: ${err.stack}`, "red"));
    childProcess.on("close", code => {
        if(code === 0)  //进程正常退出
            daemonLog(`process(${childProcess.pid}) has exited`);
        else if(code === 2)  //进程已被杀死
            daemonLog(`process(${childProcess.pid}) has been killed!`, "bgYellow");
        else if(code === 3) {  //进程主动重启
            daemonLog(`process(${childProcess.pid}) has restart`, "yellow");
            createProcess();  //重新创建进程
        }
        else {  //进程发生崩溃
            if(crashCount++ < CRASH_RESTART_LIMIT) {  //进程崩溃次数未达重启次数上限前尝试重启
                daemonLog(`process(${childProcess.pid}) has crashed! delay ${CRASH_RESTART_DELAY}ms try restarting...(${crashCount})`, "bgRed");
                setTimeout(() => createProcess(), CRASH_RESTART_DELAY);  //延迟指定时长后再重启
            }
            else  //进程已崩溃，且无法重启
                daemonLog(`process(${childProcess.pid}) has crashed! unable to restart`, "bgRed");
        }
    });  //子进程关闭监听
}

process.on("exit", code => {
    if(code === 0)
        daemonLog("daemon process exited");
    else if(code === 2)
        daemonLog("daemon process has been killed!");
});  //守护进程退出事件

process.on("SIGTERM", () => {
    daemonLog("received kill signal", "yellow");
    currentProcess && currentProcess.kill("SIGINT");
    process.exit(2);
});  //kill退出守护进程

process.on("SIGINT", () => {
    currentProcess && currentProcess.kill("SIGINT");
    process.exit(0);
});  //主动退出守护进程

createProcess();  //创建进程
