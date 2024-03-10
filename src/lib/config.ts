import serviceConfig from "./configs/service-config.ts";
import systemConfig from "./configs/system-config.ts";

class Config {
    
    /** 服务配置 */
    service = serviceConfig;
    
    /** 系统配置 */
    system = systemConfig;

}

export default new Config();