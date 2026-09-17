(() => {
  const token = __PC_BRIDGE_TOKEN__;
  const replayRuntime = (__PC_REPLAY_RUNTIME__)();
  let locate = null;
  const post = payload => parent.postMessage({ __prototypeCanvas: true, token, ...payload }, "*");

  function locateUpdate() {
    if (locate) post({ type: "prototype:locate-update", result: locate });
  }

  addEventListener("click", event => {
    if (!locate || !event.isTrusted) return;
    const element = event.target instanceof Element ? event.target : null;
    if (!element) return;
    const actionable = replayRuntime.actionableElement(element);
    // 先记录点击前的界面状态，点击生效后再判断这一步是否真的改变了界面。
    const before = replayRuntime.surfaceState();
    const action = { type: "click", ...replayRuntime.locatorFor(actionable), delay: 120 };
    locate.userInteracted = true;
    locate.actions.push(action);
    locateUpdate();
    setTimeout(() => {
      if (!locate) return;
      const after = replayRuntime.surfaceState();
      action.unchanged = replayRuntime.sameSurface(before, after);
      const surface = replayRuntime.locateTarget(actionable, before);
      if (surface) {
        locate.target = replayRuntime.locatorFor(surface);
        locate.targetLabel = replayRuntime.labelFor(surface);
        locate.fingerprint = replayRuntime.fingerprint(surface);
      }
      locateUpdate();
    }, 320);
  }, true);

  addEventListener("change", event => {
    if (!locate || !event.isTrusted) return;
    const element = event.target instanceof Element ? event.target : null;
    if (!element) return;
    locate.userInteracted = true;
    locate.actions.push({ type: "change", ...replayRuntime.locatorFor(element), value: element.value, delay: 120 });
    locateUpdate();
  }, true);

  addEventListener("message", async event => {
    const message = event.data;
    if (!message?.__prototypeCanvas || message.token !== token) return;
    try {
      if (message.type === "canvas:start-locate") {
        locate = {
          actions: [],
          baseActions: [],
          baseReplaySucceeded: false,
          userInteracted: false,
          target: message.binding?.target || { selector: null },
          fingerprint: message.binding?.fingerprint || null
        };
        locateUpdate();
      }
      if (message.type === "canvas:navigate") {
        try {
          const result = await replayRuntime.replay(message.binding?.actions || [], message.binding?.target, {
            profile: message.profile,
            dimensions: message.dimensions || [],
            timeout: Number(message.timeout || 3200),
            allowSurfaceFallback: false,
            onAction: completed => {
              if (!locate) return;
              locate.baseActions.push(completed);
              locateUpdate();
            }
          });
          if (locate) {
            locate.baseActions = result.completedActions;
            locate.baseReplaySucceeded = true;
            locateUpdate();
          }
          post({ type: "prototype:render-stable", requestId: message.requestId, fingerprint: result.fingerprint });
        } catch (error) {
          if (locate) {
            locate.baseActions = error.completedActions || locate.baseActions || [];
            locate.baseReplaySucceeded = false;
            locateUpdate();
          }
          throw error;
        }
      }
      if (message.type === "canvas:stop-locate") locate = null;
    } catch (error) {
      const step = Number.isInteger(error.stepIndex) ? `第 ${error.stepIndex + 1} 步：` : "";
      post({ type: "prototype:render-error", requestId: message.requestId, error: `${step}${error.message}` });
    }
  });

  const ready = () => post({ type: "prototype:ready" });
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", ready, { once: true });
  else queueMicrotask(ready);
})();
