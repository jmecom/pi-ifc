import _ssl
import http.client
import ipaddress
import json
import os
import re
import signal
import socket
import ssl
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit


MAX_BYTES = 1024 * 1024
CA_FILE = Path('/etc/ssl/cert.pem').resolve()


def parse_url(url):
    if not isinstance(url, str) or len(url) > 8192 or re.search(r'[^\x21-\x7e]|\\', url):
        raise ValueError('URL must be ASCII text without whitespace or backslashes.')

    target = urlsplit(url)
    if (target.scheme != 'https' or not target.hostname or target.port not in (None, 443)
            or target.username is not None or target.password is not None or target.fragment):
        raise ValueError('Use HTTPS on port 443 without credentials or a fragment.')

    return target


def public_address(value):
    address = ipaddress.ip_address(value)
    if not address.is_global or address.is_multicast:
        return False

    # Exclude IPv6 transition mechanisms that can tunnel to a private IPv4
    # address, regardless of how this Python version classifies the range.
    if address.version == 6:
        return (address in ipaddress.ip_network('2000::/3')
                and address.sixtofour is None and address.teredo is None)

    return True


def fetch(url, workspace):
    def timed_out(*_):
        raise TimeoutError()

    previous_handler = signal.signal(signal.SIGALRM, timed_out)
    signal.setitimer(signal.ITIMER_REAL, 20)
    try:
        return fetch_in_sandbox(url, workspace)
    except (OSError, ValueError, http.client.HTTPException) as error:
        # Do not return server-controlled exception messages as trusted errors.
        return f'Fetch failed: {type(error).__name__}.'
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)


def fetch_in_sandbox(url, workspace):
    target = parse_url(url)
    addresses = socket.getaddrinfo(target.hostname, 443, type=socket.SOCK_STREAM,
                                   proto=socket.IPPROTO_TCP)
    if not addresses or any(not public_address(item[4][0]) for item in addresses):
        return 'Fetch blocked: the host must resolve only to public internet addresses.'

    # Resolve once, then connect to this numeric address. A second DNS lookup
    # could give a different address and bypass the check above.
    family, _, _, _, address = min(addresses, key=lambda item: item[0] != socket.AF_INET)
    python = Path(sys.executable).resolve()
    script = Path(__file__).resolve()
    readable_directories = {Path('/usr/lib'), Path('/System/Library'), Path(sys.base_prefix).resolve()}
    readable_files = {python, script, CA_FILE, Path('/etc/ssl/cert.pem'), Path('/dev/urandom'), Path('/dev/null')}

    # Homebrew installs OpenSSL outside Python's directory. Allow the libraries
    # linked by Python's SSL module, without opening up the rest of Homebrew.
    libraries = subprocess.check_output(['/usr/bin/otool', '-L', _ssl.__file__], text=True)
    for line in libraries.splitlines()[1:]:
        library = Path(line.strip().split(' (', 1)[0])
        if library.is_absolute():
            readable_files.update((library, library.resolve()))

    ancestors = {parent for path in readable_directories | readable_files for parent in path.parents}

    profile = '\n'.join([
        '(version 1)',
        '(deny default)',
        '(import "/System/Library/Sandbox/Profiles/dyld-support.sb")',
        f'(allow process-exec (subpath {json.dumps(str(Path(sys.base_prefix).resolve()))}))',
        '(allow process-fork)',
        '(allow sysctl-read)',
        *(f'(allow file-read* (subpath {json.dumps(str(path))}))' for path in sorted(readable_directories)),
        *(f'(allow file-read* (literal {json.dumps(str(path))}))' for path in sorted(readable_files)),
        *(f'(allow file-read-metadata (literal {json.dumps(str(path))}))' for path in sorted(ancestors)),
        f'(deny file-read* file-write* (subpath {json.dumps(str(workspace))}))',
    ])

    # Pass an already-connected socket into the sandbox. The child can use
    # that connection but cannot open another one or read project files.
    with socket.socket(family, socket.SOCK_STREAM) as connection:
        connection.settimeout(10)
        connection.connect(address)
        payload = json.dumps({'url': url, 'socket_fd': connection.fileno()})
        process = subprocess.Popen(
            ['/usr/bin/sandbox-exec', '-p', profile, str(python), '-I', '-S', str(script)],
            cwd='/', env={}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, pass_fds=(connection.fileno(),), start_new_session=True,
        )
    try:
        output, _ = process.communicate(payload)
        if process.returncode:
            return 'Fetch failed: network worker could not complete.'
        return json.loads(output)
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        process.stdin.close()
        process.stdout.close()
        process.stderr.close()


def request_text(url, socket_fd):
    target = parse_url(url)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cafile=str(CA_FILE))
    connection = http.client.HTTPConnection(target.hostname, 443, timeout=10)

    try:
        with socket.socket(fileno=socket_fd) as raw:
            raw.settimeout(10)
            connection.sock = context.wrap_socket(raw, server_hostname=target.hostname)

        path = target.path or '/'
        if target.query:
            path += '?' + target.query
        connection.request('GET', path, headers={
            'User-Agent': 'pi-ifc',
            'Accept': 'text/*, application/json, application/xml, application/xhtml+xml',
            'Accept-Encoding': 'identity',
            'Connection': 'close',
        })
        response = connection.getresponse()

        if 300 <= response.status < 400:
            return f'HTTP {response.status}\nRedirect not followed.\nLocation: {response.getheader("Location", "")}'

        content_type = response.headers.get_content_type()
        if not (content_type.startswith('text/') or content_type in (
            'application/json', 'application/xml', 'application/xhtml+xml',
        )):
            return f'HTTP {response.status}\nFetch blocked: response is not a text document.'
        if response.getheader('Content-Encoding', 'identity').lower() != 'identity':
            return f'HTTP {response.status}\nFetch blocked: compressed responses are not supported.'

        body = response.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            return f'HTTP {response.status}\nFetch blocked: response exceeds 1 MiB.'

        return f'HTTP {response.status}\nContent-Type: {content_type}\n\n{body.decode("utf-8", errors="replace")}'
    finally:
        connection.close()


if __name__ == '__main__':
    try:
        result = request_text(**json.load(sys.stdin))
    except (OSError, ValueError, http.client.HTTPException) as error:
        result = f'Fetch failed: {type(error).__name__}.'
    print(json.dumps(result))
