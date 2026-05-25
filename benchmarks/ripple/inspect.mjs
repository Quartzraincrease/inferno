import { parseModule } from '@tsrx/core';

const src = `
import { useReducer } from 'inferno-next';

component App() {
  const [count, dispatch] = useReducer((s) => s + 1, 0);

  <div class="x">
    <button onClick={() => dispatch()}>{text 'click me'}</button>
    {text count}
  </div>
}
`;

const ast = parseModule(src, 'test.tsrx');
console.log(JSON.stringify(ast, null, 2).slice(0, 5000));
