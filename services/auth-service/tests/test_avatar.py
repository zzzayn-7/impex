"""Each person's own profile picture.

Covers: no picture reads as has_avatar false; a PNG/JPEG/WebP upload is decoded and stored as a fresh square PNG (nothing of the upload survives: no EXIF, no appended
bytes); the profile then says has_avatar with a version that changes on every replace; GET returns only the caller's own picture (404 when none, 401 without a token);
removing is safe to repeat; SVG, GIF, text renamed to .png, empty, too small, too large (bytes and pixels) and a wrong declared type are refused and change nothing; two
people never see each other's picture; Super Admins have their own.
"""
import io
import uuid

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.models import User
from app.security import hash_password

PASSWORD = "Str0ng!Passphrase"
ORG = str(uuid.uuid4())
AVATAR = "/api/v1/auth/me/avatar"
ME = "/api/v1/auth/me"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def add_user(session_factory, email, role="organization-admin", organization_id=ORG):
    with session_factory() as db:
        user = User(full_name="Olivia Owner", email=email, password_hash=hash_password(PASSWORD), role=role, organization_id=uuid.UUID(organization_id) if organization_id else None)
        db.add(user)
        db.commit()
        return str(user.id)


def token(client, email):
    return {"Authorization": "Bearer " + client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD}).json()["access_token"]}


def picture(fmt="PNG", size=(300, 200), color=(200, 30, 30)):
    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, format=fmt)
    return out.getvalue()


def upload(client, headers, data, content_type="image/png", name="me.png"):
    return client.put(AVATAR, files={"file": (name, data, content_type)}, headers=headers)


def test_nobody_has_a_picture_until_they_add_one(client, session_factory):
    add_user(session_factory, "a@example.org")
    headers = token(client, "a@example.org")
    me = client.get(ME, headers=headers).json()
    assert me["has_avatar"] is False and me["avatar_version"] is None
    assert client.get(AVATAR, headers=headers).status_code == 404


@pytest.mark.parametrize("fmt,mime", [("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")])
def test_a_picture_is_stored_as_a_fresh_square_png(client, session_factory, fmt, mime):
    add_user(session_factory, "a@example.org")
    headers = token(client, "a@example.org")
    res = upload(client, headers, picture(fmt), mime)
    assert res.status_code == 200 and res.json()["has_avatar"] is True and res.json()["avatar_version"]
    got = client.get(AVATAR, headers=headers)
    assert got.status_code == 200 and got.headers["content-type"] == "image/png" and got.headers["x-content-type-options"] == "nosniff"
    image = Image.open(io.BytesIO(got.content))
    assert image.format == "PNG" and image.size == (256, 256)  # centre-cropped to a square
    assert client.get(ME, headers=headers).json()["has_avatar"] is True


def test_nothing_of_the_upload_survives_but_its_pixels(client, session_factory):
    add_user(session_factory, "a@example.org")
    headers = token(client, "a@example.org")
    data = picture("PNG") + b"<script>alert(1)</script>SECRET-TRAILER"
    assert upload(client, headers, data).status_code == 200
    assert b"SECRET-TRAILER" not in client.get(AVATAR, headers=headers).content


def test_replacing_changes_the_version_and_removing_is_safe_to_repeat(client, session_factory):
    add_user(session_factory, "a@example.org")
    headers = token(client, "a@example.org")
    first = upload(client, headers, picture()).json()["avatar_version"]
    import time
    time.sleep(0.01)
    second = upload(client, headers, picture(color=(10, 200, 10))).json()["avatar_version"]
    assert first != second
    for _ in range(2):
        res = client.delete(AVATAR, headers=headers)
        assert res.status_code == 200 and res.json()["has_avatar"] is False and res.json()["avatar_version"] is None
    assert client.get(AVATAR, headers=headers).status_code == 404


@pytest.mark.parametrize("data,mime,status", [
    (b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "image/svg+xml", 415),
    (picture("GIF"), "image/gif", 415),
    (b"this is not a picture at all", "image/png", 422),
    (b"", "image/png", 422),
    (picture(size=(30, 30)), "image/png", 422),
    (picture(size=(5000, 100)), "image/png", 422),
    (picture("PNG"), "application/pdf", 415),
])
def test_anything_that_is_not_an_acceptable_picture_is_refused_and_changes_nothing(client, session_factory, data, mime, status):
    add_user(session_factory, "a@example.org")
    headers = token(client, "a@example.org")
    res = upload(client, headers, data, mime)
    assert res.status_code == status and res.json()["detail"]["code"]
    assert client.get(ME, headers=headers).json()["has_avatar"] is False


def test_a_picture_over_the_size_limit_is_refused(client, session_factory, monkeypatch):
    monkeypatch.setenv("AVATAR_MAX_BYTES", "1000")
    add_user(session_factory, "a@example.org")
    headers = token(client, "a@example.org")
    noisy = io.BytesIO()
    Image.effect_noise((300, 300), 80).convert("RGB").save(noisy, format="PNG")
    res = upload(client, headers, noisy.getvalue())
    assert res.status_code == 413 and res.json()["detail"]["code"] == "file_too_large"


def test_a_token_is_required_and_pictures_are_never_shared(client, session_factory):
    add_user(session_factory, "a@example.org")
    add_user(session_factory, "b@example.org")
    add_user(session_factory, "root@example.org", role="super-admin", organization_id=None)
    a, b, root = (token(client, e) for e in ("a@example.org", "b@example.org", "root@example.org"))
    assert client.get(AVATAR).status_code == 401
    assert client.put(AVATAR, files={"file": ("x.png", picture(), "image/png")}).status_code == 401
    assert client.delete(AVATAR).status_code == 401
    assert upload(client, a, picture(color=(255, 0, 0))).status_code == 200
    assert client.get(AVATAR, headers=b).status_code == 404 and client.get(ME, headers=b).json()["has_avatar"] is False
    assert client.get(AVATAR, headers=root).status_code == 404
    assert upload(client, root, picture(color=(0, 0, 255))).status_code == 200  # a Super Admin has their own
    mine = Image.open(io.BytesIO(client.get(AVATAR, headers=a).content)).convert("RGB").getpixel((10, 10))
    assert mine[0] > 200 and mine[2] < 60  # still A's red picture
    assert client.get(ME, headers=b).json()["has_avatar"] is False
    assert client.delete(AVATAR, headers=b).json()["has_avatar"] is False and client.get(AVATAR, headers=a).status_code == 200  # B removing nothing never touches A
