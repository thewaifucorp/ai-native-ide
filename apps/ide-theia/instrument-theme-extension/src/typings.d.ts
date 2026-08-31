// Allow side-effect CSS imports from the frontend module. Theia's webpack build
// resolves these via style-loader/css-loader; tsc just needs the module shape.
declare module '*.css';
