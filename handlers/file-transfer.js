/**
 * File transfer helpers.
 *
 * The controller never writes to a path given by the client. Output files are
 * produced in a private temporary directory, returned in the response as file
 * entries, and removed. The client (e.g. the MCP server) writes them on its side.
 *
 * File entry: { path: <relative path>, encoding: 'utf8' | 'base64', content: <string> }
 */

const fs = require('fs')
const os = require('os')
const nodePath = require('path')

const TEXT_EXTENSIONS = ['.sql', '.svg', '.md', '.html', '.htm', '.css', '.js', '.json', '.mdj', '.mfj', '.txt', '.xml']

const PDF_WAIT_INTERVAL_MS = 50
const PDF_WAIT_TIMEOUT_MS = 60000

function makeTempDir() {
    return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'staruml-controller-'))
}

function removeTempDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true })
}

function isTextFile(filePath) {
    return TEXT_EXTENSIONS.indexOf(nodePath.extname(filePath).toLowerCase()) !== -1
}

/**
 * Build a file entry from a text already in memory.
 */
function textEntry(relPath, text) {
    return { path: relPath, encoding: 'utf8', content: text }
}

/**
 * Read a file into a file entry. relPath always uses '/' as separator.
 */
function readFileEntry(absPath, relPath) {
    if (isTextFile(absPath)) {
        return { path: relPath, encoding: 'utf8', content: fs.readFileSync(absPath, 'utf8') }
    }
    return { path: relPath, encoding: 'base64', content: fs.readFileSync(absPath).toString('base64') }
}

/**
 * Read all files under dir (recursively) into file entries, sorted by path.
 */
function readDirEntries(dir) {
    const entries = []
    function walk(current, relBase) {
        fs.readdirSync(current).sort().forEach(function (name) {
            const abs = nodePath.join(current, name)
            const rel = relBase ? relBase + '/' + name : name
            if (fs.statSync(abs).isDirectory()) {
                walk(abs, rel)
            } else {
                entries.push(readFileEntry(abs, rel))
            }
        })
    }
    walk(dir, '')
    return entries
}

/**
 * Validate a file entry received from the client.
 * Returns an error message, or null if valid.
 */
function checkFileEntry(entry, fieldName) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return 'Field "' + fieldName + '" is required and must be an object { path, encoding, content }'
    }
    if (typeof entry.path !== 'string' || entry.path === '') {
        return 'Field "' + fieldName + '.path" must be a non-empty string (file name)'
    }
    if (entry.path !== nodePath.basename(entry.path) || entry.path === '.' || entry.path === '..') {
        return 'Field "' + fieldName + '.path" must be a plain file name without directories'
    }
    if (entry.encoding !== 'utf8' && entry.encoding !== 'base64') {
        return 'Field "' + fieldName + '.encoding" must be "utf8" or "base64"'
    }
    if (typeof entry.content !== 'string') {
        return 'Field "' + fieldName + '.content" must be a string'
    }
    return null
}

/**
 * Write a validated file entry into dir. Returns the absolute path.
 */
function writeFileEntry(dir, entry) {
    const abs = nodePath.join(dir, entry.path)
    if (entry.encoding === 'base64') {
        fs.writeFileSync(abs, Buffer.from(entry.content, 'base64'))
    } else {
        fs.writeFileSync(abs, entry.content, 'utf8')
    }
    return abs
}

/**
 * StarUML writes PDF through a stream and gives no completion signal.
 * A PDF file is complete when it ends with the "%%EOF" marker.
 */
function waitForPdf(absPath) {
    return new Promise(function (resolve, reject) {
        const started = Date.now()
        function check() {
            let complete = false
            if (fs.existsSync(absPath)) {
                const size = fs.statSync(absPath).size
                if (size >= 5) {
                    const fd = fs.openSync(absPath, 'r')
                    const tailLength = Math.min(size, 32)
                    const tail = Buffer.alloc(tailLength)
                    fs.readSync(fd, tail, 0, tailLength, size - tailLength)
                    fs.closeSync(fd)
                    complete = tail.toString('latin1').indexOf('%%EOF') !== -1
                }
            }
            if (complete) {
                resolve()
            } else if (Date.now() - started > PDF_WAIT_TIMEOUT_MS) {
                reject(new Error('Timed out waiting for the PDF to be written'))
            } else {
                setTimeout(check, PDF_WAIT_INTERVAL_MS)
            }
        }
        check()
    })
}

exports.makeTempDir = makeTempDir
exports.removeTempDir = removeTempDir
exports.textEntry = textEntry
exports.readFileEntry = readFileEntry
exports.readDirEntries = readDirEntries
exports.checkFileEntry = checkFileEntry
exports.writeFileEntry = writeFileEntry
exports.waitForPdf = waitForPdf
