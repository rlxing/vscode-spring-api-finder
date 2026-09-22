// 演示：前端调用代码（本插件要做的就是让这些路径能直接跳到后端 Controller）
import request from '@/utils/request';

export function wjDetail(id) {
  return request({ url: '/gw/kxgdnl/WJDetail', method: 'get', params: { id } });
}

export function wjSave(data) {
  return request({ url: `/kxgdnl/WJ/save`, method: 'post', data });
}

export function wjList(type) {
  return request({ url: `/kxgdnl/list/${type}` });
}
