export const scrollScenario = `
(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const column = (name) => [...document.querySelectorAll(".column")].find(
    (item) => item.querySelector(".column-name > span").textContent === name,
  );
  for (let attempt = 0; attempt < 300 && !column("Agent turn"); attempt++) await frame();
  if (!column("Agent turn")) throw new Error("watch board did not load");
  const board = document.querySelector(".columns");
  const implement = column("Agent turn");
  board.scrollLeft = implement.getBoundingClientRect().left - board.getBoundingClientRect().left - 6;
  await frame();
  let initialScrollLeft = board.scrollLeft;
  const header = implement.querySelector(".column-name");
  const cards = implement.querySelector(".column-cards");
  const last = cards.lastElementChild;
  const done = column("Done");
  const tabs = document.querySelector(".workflows");
  const rect = (node) => {
    const { top, bottom, left, right, width, height } = node.getBoundingClientRect();
    return { top, bottom, left, right, width, height };
  };
  const visible = (node, container) => {
    const item = rect(node), area = rect(container);
    return item.top >= area.top && item.bottom <= area.bottom && item.left >= area.left && item.right <= area.right;
  };
  const gesture = (node, distance) => {
    const area = rect(node);
    return { x: area.left + 20, y: area.top + 20, ...distance };
  };
  globalThis.watchScrolling = {
    tabs: () => {
      const boardBefore = board.scrollLeft;
      tabs.scrollLeft = tabs.scrollWidth;
      return { overflow: tabs.scrollWidth > tabs.clientWidth, scrollLeft: tabs.scrollLeft,
        boardBefore, boardAfter: board.scrollLeft };
    },
    rewind: async () => {
      board.scrollLeft = 0; initialScrollLeft = 0;
      await frame(); await frame();
      return {};
    },
    showActive: async () => {
      board.scrollLeft += rect(implement).left - rect(board).left - 6;
      await frame(); await frame();
      return {};
    },
    activeGesture: () => gesture(cards, { yDistance: -cards.scrollHeight }),
    sidewaysGesture: () => gesture(board, { xDistance: -board.scrollWidth, yDistance: 0 }),
    returnGesture: () => gesture(board, { xDistance: board.scrollWidth, yDistance: 0 }),
    doneGesture: () => {
      const list = done.querySelector(".column-cards");
      return gesture(list, { yDistance: -list.scrollHeight });
    },
    scrolled: () => ({
      header: rect(header), lastVisible: visible(last, cards), scrollTop: cards.scrollTop,
      lastOnScreen: visible(last, board),
      lastClickable: last.contains(document.elementFromPoint(rect(last).left + 20, rect(last).top + 20)),
      lastId: last.querySelector(".card-run").title,
      overflow: cards.scrollHeight > cards.clientHeight, boardScrollTop: board.scrollTop,
    }),
    horizontal: () => ({
      scrollLeft: board.scrollLeft, initialScrollLeft, doneVisible: visible(done, board), board: rect(board),
      scrollbar: board.offsetHeight - board.clientHeight,
    }),
    expand: async () => {
      done.querySelector("button").click();
      await frame();
      return {};
    },
    expanded: () => {
      const list = done.querySelector(".column-cards");
      return {
        width: rect(done).width, lastVisible: visible(list.lastElementChild, list),
        lastOnScreen: visible(list.lastElementChild, board),
        scrollTop: list.scrollTop, implementScrollTop: cards.scrollTop,
        headerVisible: visible(done.querySelector(".column-name"), board),
        lastId: list.lastElementChild.querySelector(".card-run").title,
      };
    },
    final: () => {
      window.scrollTo(10000, 10000);
      return { returned: board.scrollLeft, pageScroll: { x: scrollX, y: scrollY },
        page: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } };
    },
  };
  return {
    viewport: { width: innerWidth, height: innerHeight },
    before: { header: rect(header), lastVisible: visible(last, cards), scrollTop: cards.scrollTop },
    initiallyCollapsed: done.classList.contains("collapsed"),
    layout: {
      contentWidth: board.clientWidth - parseFloat(getComputedStyle(board).paddingLeft) - parseFloat(getComputedStyle(board).paddingRight),
      openWidths: [...board.querySelectorAll(".column:not(.collapsed)")].map(item => rect(item).width),
      collapsedWidths: [...board.querySelectorAll(".collapsed")].map(item => rect(item).width),
      overflow: board.scrollWidth > board.clientWidth,
      allVisible: [...board.children].every(item => visible(item, board)),
      fullWidth: rect(board).width === rect(document.querySelector(".workspace")).width,
      tabsAbove: rect(tabs).top >= rect(document.querySelector("header")).bottom && rect(tabs).bottom <= rect(board).top,
    },
  };
})()
`;
