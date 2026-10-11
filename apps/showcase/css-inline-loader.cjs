// Same rewrite as portal-build's `cssInline` option: component stylesheets
// (`import css from "./X.css"`) are imported as strings (`?inline`) and
// injected at runtime by useComponentCssInjection.
module.exports = function cssInlineLoader(source) {
  return source.replace(/(from\s+["'][^"']+\.css)(["'])/g, "$1?inline$2");
};
