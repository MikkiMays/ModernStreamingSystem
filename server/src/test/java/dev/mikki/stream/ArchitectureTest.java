package dev.mikki.stream;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

import com.tngtech.archunit.core.importer.ClassFileImporter;
import org.junit.jupiter.api.Test;

class ArchitectureTest {
  @Test
  void domainDoesNotDependOnWebOrMediaTransport() {
    var classes = new ClassFileImporter().importPackages("dev.mikki.stream");
    noClasses()
        .that()
        .resideInAPackage("..room..")
        .should()
        .dependOnClassesThat()
        .resideInAnyPackage(
            "..api..", "..events..", "..media..", "io.livekit..", "org.springframework.web..")
        .check(classes);
    noClasses()
        .that()
        .resideInAnyPackage("..room..", "..media..", "..attachment..", "..access..")
        .should()
        .dependOnClassesThat()
        .resideInAnyPackage("..api..", "..events..")
        .check(classes);
  }
}
