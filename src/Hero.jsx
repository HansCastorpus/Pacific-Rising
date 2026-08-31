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
          The word “rising” usually implies a positive thing. The sun rises, someone rises to the occasion,
          people soar ahead to achieve great things, and plants rise towards the sky. In the nations of the
          Pacific Ocean, something else rises: the ocean. The very element that brought life to these islands
          is becoming the very thing that could end it. The waters of the Pacific are rising. Global warming
          is bringing dramatic changes all around the world, but in the Pacific, this change is arriving
          faster than anywhere else. These are nations that have the lowest impact on global warming, yet are
          among the most exposed and vulnerable. The focus on short-term benefits is outweighing the care we
          should have for the long term. The trends are only heading one way. The water is rising.
        </p>
        <p>
          This is not only causing the direct submergence of the land. In places that seemed safer, the ocean
          is insidiously infiltrating the land itself, invading freshwater supplies and poisoning the land
          that grows the food that feeds the people living there. Storms are more likely to cause flooding.
        </p>
      </div>
    </div>
  )
}
