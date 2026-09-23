package com.dfe.extend_features.controller;

import com.dfe.kserver.annotation.ZmqController;
import com.dfe.kserver.annotation.ZmqRequestMapping;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;

import javax.annotation.Resource;

/**
 * 演示：用户真实代码的形态。
 * @ZmqRequestMapping 既是类级前缀，也是方法级路径；
 * 方法上还夹着 @ApiOperation(value = "...")，插件要先跳过它才能取到方法名。
 *
 * 期望结果：/AnalysisLsfsController/analysisOcsLsfs
 */
@ZmqRequestMapping("/AnalysisLsfsController")
@ZmqController
@Api(value = "临时方式解析OCS全量文件")
public class AnalysisLsfsController {

    @Resource
    private AnalysisLsfsService analysisLsfsService;

    @ZmqRequestMapping("/analysisOcsLsfs")
    @ApiOperation(value = "解析OCS全量文件")
    public R analysisOcsLsfs() {
        return R.ok().put("result", analysisLsfsService.analysisOcsLsfs());
    }
}
