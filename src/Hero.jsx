// Layout spec given at a 1920pt-wide reference frame, converted to vw so
// proportions hold at any viewport width:
//   container height   738pt  -> 38.4375vw
//   eyebrow   top      106pt  -> 5.5208vw   font 40pt  -> 2.0833vw
//   title     top      186pt  -> 9.6875vw   font 220pt -> 11.4583vw
//   text box  top      434pt  -> 22.6042vw  font 26pt  -> 1.3542vw
//   text box  inner padding / column gap 20px -> 1.0417vw
export default function Hero() {
  return (
    <div className="hero">
      <div className="hero-waves" aria-hidden="true" />
      <p className="hero-eyebrow">- Data Visualisation of the Impact of Rising Sea Levels -</p>
      <h1 className="hero-title">Pacific Rising</h1>
      <div className="hero-textbox">
        <p>
          Placeholder text. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
          incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation
          ullamco laboris nisi ut aliquip ex ea commodo consequat.
        </p>
        <p>
          Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla
          pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt
          mollit anim id est laborum.
        </p>
      </div>
    </div>
  )
}
