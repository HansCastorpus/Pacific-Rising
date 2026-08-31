import bannerImg from '../images/Tarawa, Kiribati - ESA.jpg'

// Banner image. Height spec: 470pt at the 1920pt reference frame ->
// 24.4792vw. Spans the full width of the central container (the
// 23pt/1.1979vw padding is handled by .app, not here).
export default function Banner() {
  return (
    <div className="banner-placeholder">
      <img src={bannerImg} alt="Aerial view of Tarawa atoll, Kiribati" />
    </div>
  )
}
