export const basicPrototypeHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>审核工作台</title>
  <style>body{font-family:Arial,sans-serif;margin:0;background:#f5f7f8;color:#1d2927}nav{display:flex;gap:8px;padding:12px;background:#fff}button{padding:8px 12px}main{padding:24px}.page{background:#fff;padding:20px}.drawer{position:fixed;right:0;top:0;width:320px;height:100%;padding:24px;background:#fff;box-shadow:-4px 0 16px #0002}</style>
</head>
<body>
  <nav><button data-role="reviewer">审核员</button><button data-role="manager">主管</button><button role="tab" aria-controls="pending">待审核</button><button role="tab" aria-controls="approved">审核通过</button><button id="openDetail">查看详情</button></nav>
  <main>
    <section id="pending" class="page" data-proto-scope="page:pending"><h1>待审核任务</h1><p>3 条记录</p></section>
    <section id="approved" class="page" data-proto-scope="page:approved" hidden><h1>审核通过</h1><p>12 条记录</p></section>
    <aside id="detail" class="drawer" data-proto-scope="drawer:detail" role="dialog" hidden><h2>任务详情</h2><button id="closeDetail">关闭</button></aside>
  </main>
  <script>
    document.querySelector('[aria-controls="pending"]').onclick=()=>{pending.hidden=false;approved.hidden=true};
    document.querySelector('[aria-controls="approved"]').onclick=()=>{pending.hidden=true;approved.hidden=false};
    document.addEventListener("click",event=>{if(!event.target.closest("#openDetail"))return;detail.hidden=false;event.stopImmediatePropagation()},true);
    Object.defineProperty(openDetail,"click",{value:null,configurable:true});closeDetail.onclick=()=>detail.hidden=true;
  </script>
</body>
</html>`;

export const genericBindingPrototypeHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>通用页面关联验收</title>
  <style>*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#f4f7fb;color:#17233d}header{height:64px;display:flex;align-items:center;gap:12px;padding:0 24px;background:#155eef;color:#fff}button{padding:8px 14px;border:1px solid #b9c9e7;border-radius:6px;background:#fff;color:#17233d}main{padding:32px}.panel{position:fixed;right:24px;top:88px;width:360px;padding:24px;border:1px solid #b9c9e7;border-radius:8px;background:#fff;box-shadow:0 12px 32px #17305f22}</style>
</head>
<body>
  <header><strong>通用业务系统</strong><button id="open-preferences">打开设置</button></header>
  <main><h1>工作台</h1><p>这个样例不使用原型画布专属属性。</p><section id="shadow-shell"></section></main>
  <aside id="preferences-panel" class="panel" role="dialog" hidden><h2>偏好设置</h2><p>普通 DOM 弹窗。</p></aside>
  <script>
    const embeddedDocument = '<body><main>嵌入内容</main></body>';
    document.querySelector("#open-preferences").addEventListener("click",()=>{document.querySelector("#preferences-panel").hidden=false});
    const root=document.querySelector("#shadow-shell").attachShadow({mode:"open"});
    root.innerHTML=\`<style>button{padding:8px 14px}.drawer{position:fixed;left:24px;bottom:24px;width:360px;padding:24px;border:1px solid #8fb4ff;border-radius:8px;background:#fff}</style><button data-testid="open-shadow-drawer">打开 Shadow 抽屉</button><aside class="drawer" role="dialog" hidden><h2>Shadow 抽屉</h2><p>开放式 Shadow DOM 交互。</p></aside>\`;
    root.querySelector("button").addEventListener("click",()=>{root.querySelector("aside").hidden=false});
  </script>
</body>
</html>`;

export const dynamicRolePrototypeHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>异步权限业务系统</title>
  <style>*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#f5f7fb;color:#17233d}.identity{height:56px;display:flex;align-items:center;gap:12px;padding:0 24px;background:#142d63;color:#fff}.top{height:56px;display:flex;gap:8px;padding:10px 24px;background:#2f6fed}.top button,.side button{padding:8px 14px;border:0;border-radius:4px;background:#fff}.layout{display:grid;grid-template-columns:220px 1fr;min-height:788px}.side{display:flex;flex-direction:column;gap:8px;padding:20px;background:#eaf0fa}.content{padding:32px}.panel{min-height:520px;padding:24px;background:#fff;border:1px solid #c8d5ec}</style>
</head>
<body>
  <div class="identity"><label>当前角色 <select id="roleSelect" aria-label="角色切换"><option value="worker">普通人员</option><option value="auditor">质检人员</option></select></label></div>
  <nav id="top-nav" class="top"></nav>
  <div class="layout"><aside id="side-nav" class="side"></aside><main id="content" class="content"><section id="home-panel" class="panel"><h1>默认工作台</h1></section></main></div>
  <script>
    let role = "worker";
    const topNav = document.querySelector("#top-nav");
    const sideNav = document.querySelector("#side-nav");
    const content = document.querySelector("#content");
    const later = (callback, delay = 260) => setTimeout(callback, delay);
    function renderTop() {
      const modules = role === "auditor"
        ? [["dashboard","工作台"],["business","业务中心"],["reports","统计分析"],["help","帮助"]]
        : [["dashboard","工作台"],["help","帮助"]];
      topNav.innerHTML = modules.map(([id,label]) => \`<button data-module="\${id}">\${label}</button>\`).join("");
    }
    function openModule(id) {
      later(() => {
        sideNav.innerHTML = id === "business" ? '<button data-page="ticketQuality">工单质检</button><button data-page="history">历史记录</button>' : '<button data-page="overview">概览</button>';
      });
    }
    function openPage(id) {
      later(() => {
        content.innerHTML = id === "ticketQuality"
          ? '<section id="ticket-panel" class="panel" role="tabpanel"><h1>工单质检</h1><p>核查工单标签并提交质检结论。</p></section>'
          : '<section class="panel"><h1>其他页面</h1></section>';
      });
    }
    document.querySelector("#roleSelect").addEventListener("change", event => { role = event.target.value; sideNav.innerHTML = ""; later(renderTop); });
    topNav.addEventListener("click", event => { const button = event.target.closest("[data-module]"); if (button) openModule(button.dataset.module); });
    sideNav.addEventListener("click", event => { const button = event.target.closest("[data-page]"); if (button) openPage(button.dataset.page); });
    renderTop();
  </script>
</body>
</html>`;
