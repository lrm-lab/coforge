import { h } from "vue";
import DefaultTheme from "vitepress/theme-without-fonts";
import DocsFootNav from "./DocsFootNav.vue";
import "./fonts/fonts.css";
import "./punctuation.css";
import "./mobile.css";

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "layout-bottom": () => h(DocsFootNav),
    });
  },
};
