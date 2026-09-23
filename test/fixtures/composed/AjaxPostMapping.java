package com.demo.composed;

import org.springframework.web.bind.annotation.PostMapping;

/**
 * 组合注解（元注解是 Spring 的 @PostMapping）。
 * 插件扫描工作区源码时会自动识别它，无需任何配置。
 */
@PostMapping
public @interface AjaxPostMapping {
    String value() default "";
}
