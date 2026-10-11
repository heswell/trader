// Component stylesheets are imported as strings and injected with
// useComponentCssInjection (see docs/ui-guide.md#styling).
declare module "*.css" {
  const css: string;
  export default css;
}
