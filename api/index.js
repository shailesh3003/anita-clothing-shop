// Keep the existing Express API and session authentication on the site's origin.
let app

module.exports = async (req, res) => {
  if (!app) {
    const { createApp } = await import('../server/src/index.js')
    app = createApp()
  }
  return app(req, res)
}
