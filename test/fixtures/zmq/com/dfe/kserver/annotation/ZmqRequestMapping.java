package com.dfe.kserver.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * 演示：框架自带的自定义映射注解。
 * 它**没有**用 Spring 的 @RequestMapping 做元注解（真实场景就是这样的），
 * 所以插件自动识别不了，需要在设置里配：
 *   "springApi.extraMappingAnnotations": ["ZmqRequestMapping:ZMQ"]
 */
@Target({ElementType.TYPE, ElementType.METHOD})
@Retention(RetentionPolicy.RUNTIME)
public @interface ZmqRequestMapping {
    String value() default "";
}
