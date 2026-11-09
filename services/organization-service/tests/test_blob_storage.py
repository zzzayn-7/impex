import pytest

from app.storage import KEY_PATTERN, BlobLogoStorage, LocalLogoStorage, StorageError, get_logo_storage

# The Vercel Blob logo storage keeps the same contract and the same safety rules as the local one. The SDK is replaced by a small in-memory fake with the
# SDK's own sync API (put_blob / get_blob / head_blob / delete_blob) and its own "not found" error type (a FileNotFoundError).


class BlobNotFoundError(FileNotFoundError):
    pass


class BlobError(Exception):
    pass


class FakeBlob:
    def __init__(self):
        self.objects, self.calls, self.fail = {}, [], None

    def _maybe_fail(self):
        if self.fail:
            raise self.fail

    def put_blob(self, pathname, body, *, access, content_type=None, add_random_suffix=False, allow_overwrite=False, **_):
        self._maybe_fail()
        self.calls.append(("put", pathname, access, content_type, add_random_suffix, allow_overwrite))
        self.objects[pathname] = bytes(body)

    def get_blob(self, pathname, *, access):
        self._maybe_fail()
        self.calls.append(("get", pathname, access))
        if pathname not in self.objects:
            raise BlobNotFoundError(pathname)
        return type("GetResult", (), {"body": self.objects[pathname]})()

    def head_blob(self, pathname):
        self._maybe_fail()
        if pathname not in self.objects:
            raise BlobNotFoundError(pathname)

    def delete_blob(self, pathname):
        self._maybe_fail()
        self.calls.append(("delete", pathname))
        self.objects.pop(pathname, None)


@pytest.fixture
def blob():
    return FakeBlob()


@pytest.fixture
def storage(blob):
    return BlobLogoStorage(client=blob)


def test_new_keys_have_the_same_unpredictable_format_as_local_keys(storage):
    keys = {storage.new_key() for _ in range(50)}
    assert len(keys) == 50 and all(KEY_PATTERN.match(k) for k in keys)


def test_a_logo_is_written_under_logos_as_a_private_png_and_read_back(storage, blob):
    key = storage.new_key()
    storage.write(key, b"\x89PNG-bytes")
    assert blob.calls == [("put", f"logos/{key}", "private", "image/png", False, True)]  # private, PNG, the name is exactly the key (no random suffix)
    assert storage.read(key) == b"\x89PNG-bytes"
    assert storage.exists(key) is True


def test_a_missing_logo_reads_as_none_and_does_not_exist(storage):
    key = storage.new_key()
    assert storage.read(key) is None
    assert storage.exists(key) is False


def test_delete_removes_it_and_never_complains(storage, blob):
    key = storage.new_key()
    storage.write(key, b"x")
    storage.delete(key)
    assert storage.read(key) is None
    storage.delete(key)  # already gone: no error
    blob.fail = BlobError("service down")
    storage.delete(key)  # a failed delete leaves a harmless, unguessable leftover


@pytest.mark.parametrize("bad", ["", "../etc/passwd", "ab/../../x.png", "ab/short.png", "AB/" + "a" * 40 + ".png", "ab/" + "a" * 40 + ".jpg", None, 5])
def test_keys_are_validated_on_every_use_and_never_reach_the_store(storage, blob, bad):
    for call in (lambda: storage.write(bad, b"x"), lambda: storage.read(bad), lambda: storage.exists(bad)):
        with pytest.raises(StorageError, match="invalid storage key"):
            call()
    assert blob.calls == []


def test_a_store_failure_is_a_storage_error_without_leaking_details(storage, blob):
    key = storage.new_key()
    blob.fail = BlobError("secret-token=abc123 internal detail")
    for call in (lambda: storage.write(key, b"x"), lambda: storage.read(key), lambda: storage.exists(key)):
        with pytest.raises(StorageError) as caught:
            call()
        assert "secret-token" not in str(caught.value) and "BlobError" in str(caught.value)


def test_the_access_mode_must_be_private_or_public():
    assert BlobLogoStorage(access="public", client=FakeBlob()).access == "public"
    with pytest.raises(StorageError):
        BlobLogoStorage(access="open", client=FakeBlob())


class TestSelection:
    def test_local_is_the_default_and_blob_is_chosen_by_setting_or_by_running_on_vercel(self, monkeypatch, tmp_path):
        for name in ("LOGO_STORAGE", "VERCEL", "LOGO_BLOB_ACCESS"):
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv("LOGO_STORAGE_DIR", str(tmp_path))
        assert isinstance(get_logo_storage(), LocalLogoStorage)
        monkeypatch.setenv("LOGO_STORAGE", "blob")
        chosen = get_logo_storage()
        assert isinstance(chosen, BlobLogoStorage) and chosen.access == "private"
        monkeypatch.delenv("LOGO_STORAGE")
        monkeypatch.setenv("VERCEL", "1")
        assert isinstance(get_logo_storage(), BlobLogoStorage)  # nothing set on Vercel: still not the (non-persistent) local disk
        monkeypatch.setenv("LOGO_STORAGE", "local")
        assert isinstance(get_logo_storage(), LocalLogoStorage)  # an explicit choice wins
        monkeypatch.setenv("LOGO_STORAGE", "blob")
        monkeypatch.setenv("LOGO_BLOB_ACCESS", "public")
        assert get_logo_storage().access == "public"
