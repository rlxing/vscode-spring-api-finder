package com.demo.composed;

import org.springframework.web.bind.annotation.RequestMapping;

/** 组合注解：自带固定前缀路径 /ajax */
@RequestMapping("/ajax")
public @interface AjaxBaseMapping {
}
