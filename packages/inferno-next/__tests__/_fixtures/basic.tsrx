export component Hello() {
  <div class='greet'>{text 'Hello, world'}</div>
}

export component Counter(props) {
  <span>{text props.n}</span>
}

export component Greet(props) {
  <p>{text 'Hello, '}{text props.name}{text ' !'}</p>
}

export component Mixed() {
  <div id='m'>
    <span class='a'>{text 'A'}</span>
    <span class='b'>{text 'B'}</span>
  </div>
}
