import { getFileName, getParentFolder, canonicalizeVarName } from "src/util/normalize"

test("empty getFileName()", () => {
    expect(getFileName("")).toEqual("");
});

test("root getFileName()", () => {
    expect(getFileName("yes.md")).toEqual("yes");
    expect(getFileName("yes")).toEqual("yes");
});

test("folder getFileName()", () => {
    expect(getFileName("ok/yes.md")).toEqual("yes");
    expect(getFileName("/yes")).toEqual("yes");
});

test("empty getParentFolder", () => {
    expect(getParentFolder("")).toEqual("");
});

test("root getParentFolder", () => {
    expect(getParentFolder("yes")).toEqual("");
    expect(getParentFolder("maybe")).toEqual("");
});

test("folder getParentFolder()", () => {
    expect(getParentFolder("ok/yes")).toEqual("ok");
    expect(getParentFolder("no/maybe")).toEqual("no");
    expect(getParentFolder("/maybe")).toEqual("");
})

test("simple canonicalizeVarName()", () => {
    expect(canonicalizeVarName("test")).toEqual("test");
    expect(canonicalizeVarName("test thing")).toEqual("test-thing");
    expect(canonicalizeVarName("test thing 3")).toEqual("test-thing-3");
    expect(canonicalizeVarName("This is a Test.")).toEqual("this-is-a-test");
    expect(canonicalizeVarName("property")).toEqual("property");
})