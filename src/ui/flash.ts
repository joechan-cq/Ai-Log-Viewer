const BLINKS = 6
const BLINK_MS = 420

/** 记住每个元素正在播的动画，重复跳转时先取消再重播 */
const running = new WeakMap<Element, Animation>()

/**
 * 跳转定位后让目标卡片边框闪几下。
 *
 * 用 Web Animations API 而不是 CSS class：class 是声明式渲染在管的，
 * 命令式加上去的 class 随时可能被重渲染覆盖掉，实测只闪一下就没了。
 * el.animate() 直接挂在元素上，跟 DOM 属性无关，重渲染也打断不了。
 * 同时用 box-shadow 而不是 border —— 不改变布局尺寸，不会干扰滚动定位。
 */
export function flashElement(el: Element) {
  running.get(el)?.cancel()

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6aa8ff'
  const off = '0 0 0 0 rgba(0,0,0,0)'
  const on = `0 0 0 2px ${accent}`

  const anim = el.animate(
    [
      { boxShadow: off, offset: 0 },
      { boxShadow: on, offset: 0.5 },
      { boxShadow: off, offset: 1 },
    ],
    { duration: BLINK_MS, iterations: BLINKS, easing: 'ease-in-out' },
  )
  running.set(el, anim)
  anim.finished.catch(() => {}).finally(() => {
    if (running.get(el) === anim) running.delete(el)
  })
}
