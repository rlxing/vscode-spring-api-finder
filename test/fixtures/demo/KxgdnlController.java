package com.demo.wj;

import org.springframework.web.bind.annotation.*;

/**
 * 演示：路径被拆成"类上一段 + 方法上一段"的典型写法。
 * 前端搜 /kxgdnl/WJDetail 时，全文搜索是搜不到的，本插件会拼起来。
 */
@RestController
@RequestMapping("/kxgdnl")
public class KxgdnlController {

    private static final String WJ = "/WJ";

    /** 前端: url: '/gw/kxgdnl/WJDetail'（/gw 是 context-path） */
    @GetMapping("/WJDetail")
    public Object wjDetail(@RequestParam("id") String id) {
        return null;
    }

    /** 前端: url: `/kxgdnl/WJ/save` */
    @PostMapping(WJ + "/save")
    public Object save(@RequestBody Object body) {
        return null;
    }

    /** 前端: url: `/kxgdnl/list/${type}` */
    @GetMapping("/list/{type}")
    public Object list(@PathVariable String type) {
        return null;
    }

    /** 路径解析不出来（常量在其他类里）也要能按剩余片段搜到 */
    @GetMapping(Constants.UNKNOWN_PATH)
    public Object unknown() {
        return null;
    }
}
