/**
 * StarUML Controller - Main Entry Point
 *
 * Provides an HTTP server within StarUML to allow remote control
 * of diagrams via REST API. Every request must carry the password
 * chosen at server start (Authorization: Bearer <password>).
 */

const http = require('http')
const crypto = require('crypto')
const { clipboard } = require('electron')
const apiHandler = require('./api-handler')

const DEFAULT_PORT = 12345
const PASSWORD_PREFERENCE_KEY = 'staruml-controller.password'
let server = null
let currentPort = null
let currentPassword = null

/**
 * The saved password, or a new random UUID if none is saved yet
 */
function getSavedOrNewPassword() {
  return app.preferences.get(PASSWORD_PREFERENCE_KEY) || crypto.randomUUID()
}

/**
 * Compare in constant time so that response timing does not leak the password
 */
function isAuthorized(req) {
  if (!currentPassword) {
    return false
  }
  const header = req.headers['authorization']
  if (typeof header !== 'string') {
    return false
  }
  const expected = crypto.createHash('sha256').update('Bearer ' + currentPassword).digest()
  const actual = crypto.createHash('sha256').update(header).digest()
  return crypto.timingSafeEqual(expected, actual)
}

/**
 * Send JSON response with appropriate status code
 */
function sendResponse(res, result) {
  let statusCode = 200
  if (result.success) {
    statusCode = 200
  } else if (result.error && /^([\w ]+)?not found: /i.test(result.error)) {
    statusCode = 404
  } else if (result.error) {
    statusCode = 400
  }
  res.writeHead(statusCode)
  res.end(JSON.stringify(result, null, 2))
}

/**
 * Start the HTTP server
 */
function startServer(port, password) {
  if (server) {
    app.toast.warning('Server is already running on port ' + currentPort)
    return
  }

  currentPassword = password

  server = http.createServer(function (req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')

    // Reject before reading the body. No CORS headers are sent, so browsers
    // cannot call this API from web pages.
    if (!isAuthorized(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      res.writeHead(401)
      res.end(JSON.stringify({ success: false, error: 'Unauthorized: send the server password as "Authorization: Bearer <password>"' }, null, 2))
      req.resume()
      return
    }

    // Collect request body (limit to 10MB)
    const MAX_BODY_SIZE = 10 * 1024 * 1024
    const bodyChunks = []
    let bodySize = 0
    let bodyTooLarge = false
    req.on('data', function (chunk) {
      bodySize += chunk.length
      if (bodySize > MAX_BODY_SIZE) {
        bodyTooLarge = true
        req.destroy()
        return
      }
      bodyChunks.push(chunk)
    })
    req.on('end', function () {
      if (bodyTooLarge) {
        res.writeHead(413)
        res.end(JSON.stringify({ success: false, error: 'Request body too large (max 10MB)' }))
        return
      }

      let body = {}
      if (bodyChunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(bodyChunks).toString())
        } catch (e) {
          res.writeHead(400)
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON in request body' }))
          return
        }
        // Unescape common escape sequences in multi-line text fields.
        // MCP tool parameters pass \n as literal backslash+n (not a newline character),
        // so we convert them here at the API entry point.
        if (typeof body.text === 'string') {
          body.text = body.text.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        }
        if (typeof body.documentation === 'string') {
          body.documentation = body.documentation.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        }
      }

      try {
        const result = apiHandler.route(req.method, req.url, body)

        if (result && typeof result.then === 'function') {
          result.then(function (asyncResult) {
            sendResponse(res, asyncResult)
          }).catch(function (e) {
            console.error('[StarUML Controller] Error:', e)
            res.writeHead(500)
            res.end(JSON.stringify({ success: false, error: e.message || 'Internal server error' }))
          })
        } else {
          sendResponse(res, result)
        }
      } catch (e) {
        console.error('[StarUML Controller] Error:', e)
        res.writeHead(500)
        res.end(JSON.stringify({ success: false, error: e.message || 'Internal server error' }))
      }
    })
  })

  server.on('error', function (err) {
    console.error('[StarUML Controller] Server error:', err)
    if (err.code === 'EADDRINUSE') {
      app.dialogs.showErrorDialog('Port ' + port + ' is already in use. Please choose another port.')
    } else {
      app.dialogs.showErrorDialog('Server error: ' + err.message)
    }
    server = null
    currentPort = null
    currentPassword = null
  })

  server.listen(port, function () {
    currentPort = port
    clipboard.writeText(password)
    console.log('[StarUML Controller] Server started on port ' + port)
    app.toast.info('StarUML Controller server started on port ' + port + '. Password copied to clipboard.')
  })
}

/**
 * Stop the HTTP server
 */
function stopServer() {
  if (!server) {
    app.toast.warning('Server is not running')
    return
  }

  server.close(function () {
    console.log('[StarUML Controller] Server stopped')
    app.toast.info('StarUML Controller server stopped')
    server = null
    currentPort = null
    currentPassword = null
  })
}

/**
 * Dialog that asks for the port and the password at once.
 * The OK button is not a ".dialog-button", so the dialog stays open while the input is invalid.
 */
const START_DIALOG_TEMPLATE = [
  '<div class="staruml-controller-start-dialog dialog modal" data-title="Start StarUML Controller Server">',
  '  <div class="dialog-body" style="width: 30em">',
  '    <div class="dialog-message">Port</div>',
  '    <input type="text" class="k-input k-textbox port" style="width: 100%; margin-bottom: 1em">',
  '    <div class="dialog-message">Password</div>',
  '    <input type="text" class="k-input k-textbox password" style="width: 100%" spellcheck="false">',
  '    <div style="margin-top: 0.5em">',
  '      <button class="k-button regenerate">Regenerate</button>',
  '      <button class="k-button copy">Copy</button>',
  '      <span class="copied" style="margin-left: 0.5em; display: none">Copied</span>',
  '    </div>',
  '    <div class="dialog-message" style="margin-top: 1em">Clients must send the password with every request. It is copied to the clipboard when the server starts.</div>',
  '    <div class="error" style="margin-top: 0.5em; color: #e0504a; display: none"></div>',
  '  </div>',
  '  <div class="dialog-footer">',
  '    <button class="k-button primary start">Start Server</button>',
  '    <button class="k-button dialog-button" data-button-id="cancel">Cancel</button>',
  '  </div>',
  '</div>'
].join('\n')

/**
 * Validate the dialog input. Returns { port, password } or { error }.
 */
function readStartInput(portText, passwordText) {
  const portValue = String(portText).trim()
  const port = parseInt(portValue, 10)
  if (!/^[0-9]+$/.test(portValue) || port < 1 || port > 65535) {
    return { error: 'Invalid port number. Please enter a number between 1 and 65535.' }
  }
  const password = String(passwordText).trim()
  if (password === '') {
    return { error: 'The password must not be empty.' }
  }
  return { port: port, password: password }
}

/**
 * Handle start server command - ask for the port and the password, then start
 */
function handleStartServer() {
  if (server) {
    app.toast.warning('Server is already running on port ' + currentPort)
    return
  }

  const dialog = app.dialogs.showModalDialogUsingTemplate(START_DIALOG_TEMPLATE, true)
  const $dlg = dialog.getElement()
  const $port = $dlg.find('.port')
  const $password = $dlg.find('.password')
  const $error = $dlg.find('.error')
  const $copied = $dlg.find('.copied')

  $port.val(String(DEFAULT_PORT))
  $password.val(getSavedOrNewPassword())
  $port.focus().select()

  $dlg.find('.regenerate').click(function () {
    $password.val(crypto.randomUUID())
    $copied.hide()
  })

  $dlg.find('.copy').click(function () {
    clipboard.writeText(String($password.val()).trim())
    $copied.show()
  })

  $password.on('input', function () {
    $copied.hide()
  })

  $dlg.find('.start').click(function () {
    const input = readStartInput($port.val(), $password.val())
    if (input.error) {
      $error.text(input.error).show()
      return
    }
    $dlg.data('returnValue', input)
    dialog.close('ok')
  })

  dialog.then(function (result) {
    if (result.buttonId !== 'ok') {
      return
    }
    app.preferences.set(PASSWORD_PREFERENCE_KEY, result.returnValue.password)
    startServer(result.returnValue.port, result.returnValue.password)
  })
}

/**
 * Handle stop server command
 */
function handleStopServer() {
  stopServer()
}

/**
 * Initialize the extension
 */
function init() {
  app.commands.register('controller:start-server', handleStartServer)
  app.commands.register('controller:stop-server', handleStopServer)
}

exports.init = init
