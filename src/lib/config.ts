import serviceConfig from "./configs/service-config.ts";
import systemConfig from "./configs/system-config.ts";
import apiConfig from "./configs/api-config.ts";

class Config {
    
    /** 服务配置 */
    service = serviceConfig;
    
    /** 系统配置 */
    system = systemConfig;

    /** API配置 */
    api = apiConfig;

}

export default new Config();