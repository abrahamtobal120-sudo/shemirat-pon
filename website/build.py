from pathlib import Path
import shutil
import zipfile

repo = Path(__file__).resolve().parent.parent
output = repo / "public"
output.mkdir(exist_ok=True)
shutil.copyfile(repo / "website" / "index.html", output / "index.html")
downloads = output / "downloads"
downloads.mkdir(exist_ok=True)
extension = repo / "shomer-web"
with zipfile.ZipFile(downloads / "shomer-web.zip", "w", zipfile.ZIP_DEFLATED) as archive:
    for source in sorted(extension.rglob("*")):
        if source.is_file() and source.relative_to(extension).parts[0] not in ("_metadata", "scripts", "tools"):
            archive.write(source, "shomer-web/" + source.relative_to(extension).as_posix())
    archive.writestr("LEEME.txt", "Descomprime el ZIP. Abre chrome://extensions, activa Modo de desarrollador y pulsa Cargar descomprimida. Selecciona la carpeta shomer-web. Consulta la web para ver los pasos completos.")
with zipfile.ZipFile(downloads / "shomer-web.zip") as archive:
    if archive.testzip() is not None:
        raise RuntimeError("El archivo de descarga no superó la verificación.")
print("Página y descarga generadas correctamente.")
