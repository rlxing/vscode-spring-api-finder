package com.demo.composed;

import org.springframework.web.bind.annotation.RequestBody;

/**
 * 演示：只用了自定义组合注解，没有出现任何 Spring 注解。
 * 期望结果（自动识别，无需配置）：
 *   POST /ajax/submit
 *   POST /ajax/save
 */
@AjaxBaseMapping
public class AjaxController {

    @AjaxPostMapping("/submit")
    public Object submit(@RequestBody Object body) {
        return null;
    }

    @AjaxPostMapping(value = "/save", name = "saveApi")
    public Object save() {
        return null;
    }
}
